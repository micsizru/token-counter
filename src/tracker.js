'use strict';

/**
 * TokenTracker orchestrator: coordinates Antigravity state watchers, active conversation detection,
 * incremental transcript reading, context limit resolution, and snapshot emission.
 */

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_MODEL_LIMITS,
  formatTokenCount,
  getEfficiencyStatus,
  normalizeConfig,
  buildEmptySnapshot,
  computeBloatLevel,
  computeCapacityMetrics,
  mergeModelsUsed,
} = require('./tracker/metrics');
const {
  readWorkspaceLastConversationId,
  readGlobalAuxPaneConversationIds,
} = require('./tracker/sqlite');
const {
  isSubagentSummary,
  loadSummariesWithAnnotations,
} = require('./tracker/summaries');
const {
  normalizePathForCompare,
  normalizeWorkspaceFolders,
  detectActiveConversationId,
} = require('./tracker/active-chat');
const {
  createEmptyTranscriptState,
  getTranscriptPath,
  readTranscriptIncremental,
  readTranscriptIntoState,
  readTranscriptTailPreview,
} = require('./tracker/transcript');
const {
  resolveContextLimitAndDisplayName,
  resolvePreviewLimitAndDisplayName,
} = require('./tracker/limits');
const { buildMessageTimeline } = require('./tracker/timeline');
const {
  attachStaticWatchers,
  ensureTranscriptWatcher,
  closeWatcher,
  scheduleRefresh,
  clearDebounceTimer,
  syncSafetyTimer,
  clearSafetyTimer,
} = require('./tracker/watchers');

class TokenTracker {
  /**
   * @param {object} options
   * @param {string} options.antigravityDir
   * @param {string | null} [options.workspaceStateDbPath]
   * @param {string | null} [options.globalStateDbPath]
   * @param {Array<any>} [options.workspaceFolders]
   * @param {object} [options.config]
   * @param {(snapshot: object) => void} [options.onUpdate]
   */
  constructor(options = {}) {
    this.antigravityDir = options.antigravityDir || '';
    this.workspaceStateDbPath = options.workspaceStateDbPath || null;
    this.globalStateDbPath = options.globalStateDbPath || null;
    this.workspaceFolders = normalizeWorkspaceFolders(options.workspaceFolders || []);
    this.config = this._normalizeConfig(options.config);
    this.onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;

    this._running = false;
    this._disposed = false;
    this._windowFocused = true;
    this._pinnedConversationId = null;

    // Caches to avoid unnecessary disk / SQLite I/O
    this._summariesCache = { key: '', list: [], byId: new Map() };
    this._annotationsCache = new Map();
    this._wsStateCache = { key: '', lastConversationId: null, mtimeMs: 0 };
    this._globalStateCache = { key: '', paneIds: [] };
    this._convDbCache = new Map();
    this._convDbById = new Map();
    this._tailPreviewCache = new Map();
    this._timelineCache = new Map();

    this._transcript = createEmptyTranscriptState(null, null);

    // Watchers & timers
    this._wsStateWatcher = null;
    this._summariesWatcher = null;
    this._annotationsWatcher = null;
    this._transcriptWatcher = null;
    this._transcriptWatchedTarget = null;
    this._debounceTimer = null;
    this._safetyTimer = null;

    this._lastSnapshotJson = '';
    this._snapshot = this._buildEmptySnapshot(Boolean(this.config.enabled), null);
  }

  _normalizeConfig(raw) {
    return normalizeConfig(raw);
  }

  _buildEmptySnapshot(enabled, note) {
    return buildEmptySnapshot(
      enabled,
      note,
      this._pinnedConversationId,
      this.config.defaultContextLimit
    );
  }

  /**
   * Start tracking, attach watchers, run initial refresh, and start safety timer if focused.
   */
  start() {
    if (this._disposed) {
      return;
    }
    if (this._running) {
      this.refresh();
      return;
    }
    this._running = true;
    this.config.enabled = true;
    this._attachStaticWatchers();
    this._syncSafetyTimer();
    this.refresh(true);
  }

  /**
   * Immediately stop all watchers and timers. Zero active handles remain.
   */
  stop() {
    this._running = false;
    this.config.enabled = false;
    this._clearDebounceTimer();
    this._clearSafetyTimer();
    this._closeWatcher('_wsStateWatcher');
    this._closeWatcher('_summariesWatcher');
    this._closeWatcher('_annotationsWatcher');
    this._closeWatcher('_transcriptWatcher');
    this._transcriptWatchedTarget = null;

    this._snapshot = {
      ...this._snapshot,
      enabled: false,
      bloatLevel: 'none',
      note: 'Takip duraklatıldı',
    };
    this._emitUpdate(true);
  }

  /**
   * Pause/resume the 5-second safety timer based on window focus.
   *
   * @param {boolean} focused
   */
  setWindowFocused(focused) {
    const next = Boolean(focused);
    if (this._windowFocused === next) {
      return;
    }
    this._windowFocused = next;
    this._syncSafetyTimer();
    if (this._running && next) {
      this._scheduleRefresh();
    }
  }

  /**
   * Update configuration dynamically.
   *
   * @param {object} config
   */
  updateConfig(config) {
    const prevEnabled = this.config.enabled;
    this.config = this._normalizeConfig({ ...this.config, ...(config || {}) });

    if (!this.config.enabled) {
      if (this._running || prevEnabled) {
        this.stop();
      } else {
        this._snapshot = { ...this._snapshot, enabled: false };
        this._emitUpdate(true);
      }
      return;
    }

    if (this._running) {
      this.refresh(true);
    } else if (!prevEnabled && this.config.enabled) {
      this.start();
    }
  }

  /**
   * Update open workspace folders for active conversation matching.
   *
   * @param {Array<any>} folders
   */
  updateWorkspaceFolders(folders) {
    this.workspaceFolders = normalizeWorkspaceFolders(folders || []);
    if (this._running) {
      this.refresh(true);
    }
  }

  /**
   * Pin a specific conversation UUID, or pass null/empty string to return to auto mode.
   *
   * @param {string | null} idOrNull
   */
  setPinnedConversation(idOrNull) {
    const next = typeof idOrNull === 'string' && idOrNull.trim() ? idOrNull.trim() : null;
    if (this._pinnedConversationId === next) {
      return;
    }
    this._pinnedConversationId = next;
    if (this._running) {
      this.refresh(true);
    } else {
      this._snapshot = {
        ...this._snapshot,
        mode: next ? 'pinned' : 'auto',
        conversationId: next || this._snapshot.conversationId,
      };
      this._emitUpdate(true);
    }
  }

  /**
   * Return the most recent snapshot object (shallow copy).
   */
  getSnapshot() {
    return {
      ...this._snapshot,
      modelsUsed: Array.isArray(this._snapshot.modelsUsed) ? [...this._snapshot.modelsUsed] : [],
    };
  }

  /**
   * List recent non-subagent conversations for UI selection / pinning / sidebar preview.
   *
   * @param {number} [limit=30]
   * @param {{ includeTokens?: boolean }} [options={}]
   */
  listConversations(limit = 30, options = {}) {
    const maxItems = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 30;
    const includeTokens = Boolean(options && options.includeTokens);
    const { list, byId } = this._loadSummariesWithAnnotations();

    const candidates = list
      .filter((s) => !isSubagentSummary(s))
      .map((s) => {
        const normWs = normalizePathForCompare(s.workspacePath || s.workspaceUri);
        const matchesWorkspace =
          this.workspaceFolders.length > 0 && normWs !== '' && this.workspaceFolders.includes(normWs);
        const lastActivityMs = Math.max(
          s.lastUserViewMs || 0,
          s.lastUserInputMs || 0,
          s.lastModifiedMs || 0
        );
        const workspaceName = s.workspacePath
          ? path.basename(s.workspacePath.replace(/[\\/]+$/, ''))
          : '';

        return {
          id: s.id,
          title: s.title || '(Başlıksız sohbet)',
          status: s.status,
          workspacePath: s.workspacePath || '',
          workspaceName,
          matchesWorkspace,
          stepCount: s.stepCount || 0,
          lastActivityMs,
          lastModifiedMs: s.lastModifiedMs || 0,
          lastUserViewMs: s.lastUserViewMs || 0,
          lastUserInputMs: s.lastUserInputMs || 0,
          hasTranscript: false,
        };
      });

    candidates.sort((a, b) => {
      if (this.workspaceFolders.length > 0 && a.matchesWorkspace !== b.matchesWorkspace) {
        return a.matchesWorkspace ? -1 : 1;
      }
      const aRunning = a.status === 'running' ? 1 : 0;
      const bRunning = b.status === 'running' ? 1 : 0;
      if (aRunning !== bRunning) {
        return bRunning - aRunning;
      }
      return b.lastActivityMs - a.lastActivityMs;
    });

    const sliced = candidates.slice(0, maxItems);
    const activeAutoId = includeTokens ? this._detectActiveConversationId(list, byId) : null;

    for (const item of sliced) {
      const transcriptPath = this._getTranscriptPath(item.id);
      if (!includeTokens) {
        try {
          item.hasTranscript = fs.existsSync(transcriptPath);
        } catch {
          item.hasTranscript = false;
        }
        continue;
      }

      const preview = this._readTranscriptTailPreview(item.id, transcriptPath);
      item.hasTranscript = preview.hasTranscript;
      item.isActiveAuto = item.id === activeAutoId;

      const { limit: ctxLimit, displayName } = this._resolvePreviewLimitAndDisplayName(
        item.id,
        preview.model
      );

      item.model = preview.model;
      item.modelDisplayName = displayName || preview.model || null;

      if (preview.hasUsage && ctxLimit > 0) {
        const pct = Math.round((preview.contextTokens / ctxLimit) * 1000) / 10;
        item.contextTokens = preview.contextTokens;
        item.contextLimit = ctxLimit;
        item.percent = pct;
        item.bloatLevel = this._computeBloatLevel(pct);
      } else {
        item.contextTokens = null;
        item.contextLimit = null;
        item.percent = null;
        item.bloatLevel = 'none';
      }
    }

    return sliced;
  }

  /**
   * Inspect any conversation by ID and return a full TrackerSnapshot-shaped object
   * without mutating the live active tracker state, watchers, or emitting onUpdate.
   *
   * @param {string} conversationId
   */
  inspectConversation(conversationId) {
    if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
      return this._buildEmptySnapshot(Boolean(this.config.enabled), 'Sohbet seçilmedi');
    }

    const id = conversationId.trim();

    // Zero duplicate I/O if inspecting the already-loaded active tracked conversation
    if (
      this._snapshot.conversationId === id &&
      this._transcript.conversationId === id &&
      (this._running || this._transcript.byteOffset > 0)
    ) {
      return this.getSnapshot();
    }

    const { byId } = this._loadSummariesWithAnnotations();
    const summary = byId.get(id) || null;
    const transcriptPath = this._getTranscriptPath(id);
    const localState = createEmptyTranscriptState(id, transcriptPath);
    this._readTranscriptIntoState(localState);

    const { limit, source, displayName, dbModels } = this._resolveContextLimitAndDisplayName(
      id,
      localState.model,
      localState.turnCount
    );

    const hasUsage = localState.hasTranscript && localState.turnCount > 0 && limit > 0;
    const percent = hasUsage
      ? Math.round((localState.contextTokens / limit) * 1000) / 10
      : 0;
    const bloatLevel = hasUsage ? this._computeBloatLevel(percent) : 'none';
    const { avgContextGrowthPerMessage, estimatedRemainingMessages } =
      this._computeCapacityMetrics(localState, limit);

    let note = null;
    if (!localState.hasTranscript) {
      note = 'Bu sohbet için henüz transcript.jsonl oluşmadı';
    } else if (localState.turnCount === 0) {
      note = 'İlk model yanıtı bekleniyor';
    }

    return {
      enabled: Boolean(this.config.enabled),
      mode: id === this._pinnedConversationId ? 'pinned' : 'auto',
      conversationId: id,
      title: (summary && summary.title) || '',
      status: (summary && summary.status) || 'unknown',
      model: localState.model,
      modelDisplayName: displayName || localState.model || null,
      modelsUsed: this._mergeModelsUsed(dbModels, localState.models),
      contextTokens: localState.contextTokens,
      contextLimit: limit,
      contextLimitSource: source,
      percent,
      bloatLevel,
      lastInputTokens: localState.lastInputTokens,
      lastCacheReadTokens: localState.lastCacheReadTokens,
      lastOutputTokens: localState.lastOutputTokens,
      totalInputTokens: localState.totalInputTokens,
      totalCacheReadTokens: localState.totalCacheReadTokens,
      totalOutputTokens: localState.totalOutputTokens,
      turnCount: localState.turnCount,
      compactionCount: localState.compactionCount,
      avgContextGrowthPerMessage,
      estimatedRemainingMessages,
      lastUpdatedAt: localState.lastUpdatedAt,
      hasTranscript: localState.hasTranscript,
      note,
    };
  }

  /**
   * Build a chronological, message-by-message token timeline for a conversation.
   *
   * @param {string} conversationId
   */
  getMessageTimeline(conversationId) {
    return buildMessageTimeline(this, conversationId);
  }

  /**
   * Run a synchronous refresh cycle: detect active conversation, read incremental transcript,
   * resolve context budget & model display name, compute snapshot, and notify if changed.
   *
   * @param {boolean} [forceEmit=false]
   */
  refresh(forceEmit = false) {
    if (this._disposed) {
      return this.getSnapshot();
    }

    if (!this.config.enabled && !this._running) {
      this._snapshot = {
        ...this._snapshot,
        enabled: false,
        bloatLevel: 'none',
      };
      if (forceEmit) {
        this._emitUpdate(true);
      }
      return this.getSnapshot();
    }

    const { list, byId } = this._loadSummariesWithAnnotations();
    const mode = this._pinnedConversationId ? 'pinned' : 'auto';
    const conversationId =
      mode === 'pinned'
        ? this._pinnedConversationId
        : this._detectActiveConversationId(list, byId);

    if (!conversationId) {
      this._transcript = createEmptyTranscriptState(null, null);
      if (this._running) {
        this._closeWatcher('_transcriptWatcher');
        this._transcriptWatchedTarget = null;
      }
      this._snapshot = this._buildEmptySnapshot(
        Boolean(this.config.enabled),
        'Aktif Antigravity sohbeti bulunamadı'
      );
      this._emitUpdate(forceEmit);
      return this.getSnapshot();
    }

    const summary = byId.get(conversationId) || null;
    const transcriptPath = this._getTranscriptPath(conversationId);

    if (this._running) {
      this._ensureTranscriptWatcher(conversationId, transcriptPath);
    }

    this._readTranscriptIncremental(conversationId, transcriptPath);

    const t = this._transcript;
    const { limit, source, displayName, dbModels } = this._resolveContextLimitAndDisplayName(
      conversationId,
      t.model,
      t.turnCount
    );

    const hasUsage = t.hasTranscript && t.turnCount > 0 && limit > 0;
    const percent = hasUsage
      ? Math.round((t.contextTokens / limit) * 1000) / 10
      : 0;
    const { avgContextGrowthPerMessage, estimatedRemainingMessages } =
      this._computeCapacityMetrics(t, limit);

    const bloatLevel =
      this.config.enabled && hasUsage ? this._computeBloatLevel(percent) : 'none';

    let note = null;
    if (!t.hasTranscript) {
      note = 'Bu sohbet için henüz transcript.jsonl oluşmadı';
    } else if (t.turnCount === 0) {
      note = 'İlk model yanıtı bekleniyor';
    }

    this._snapshot = {
      enabled: Boolean(this.config.enabled),
      mode,
      conversationId,
      title: (summary && summary.title) || '',
      status: (summary && summary.status) || 'unknown',
      model: t.model,
      modelDisplayName: displayName || t.model || null,
      modelsUsed: this._mergeModelsUsed(dbModels, t.models),
      contextTokens: t.contextTokens,
      contextLimit: limit,
      contextLimitSource: source,
      percent,
      bloatLevel,
      lastInputTokens: t.lastInputTokens,
      lastCacheReadTokens: t.lastCacheReadTokens,
      lastOutputTokens: t.lastOutputTokens,
      totalInputTokens: t.totalInputTokens,
      totalCacheReadTokens: t.totalCacheReadTokens,
      totalOutputTokens: t.totalOutputTokens,
      turnCount: t.turnCount,
      compactionCount: t.compactionCount,
      avgContextGrowthPerMessage,
      estimatedRemainingMessages,
      lastUpdatedAt: t.lastUpdatedAt,
      hasTranscript: t.hasTranscript,
      note,
    };

    this._emitUpdate(forceEmit);
    return this.getSnapshot();
  }

  /**
   * Release all resources permanently.
   */
  dispose() {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this.onUpdate = null;
    this.stop();
  }

  // ---------------------------------------------------------------------------
  // Internal delegation helpers
  // ---------------------------------------------------------------------------

  _computeBloatLevel(percent) {
    return computeBloatLevel(percent, this.config);
  }

  _computeCapacityMetrics(state, contextLimit) {
    return computeCapacityMetrics(state, contextLimit);
  }

  _mergeModelsUsed(dbModels, transcriptModels) {
    return mergeModelsUsed(dbModels, transcriptModels);
  }

  _detectActiveConversationId(summaries, byId) {
    return detectActiveConversationId(
      {
        workspaceFolders: this.workspaceFolders,
        readWorkspaceLastConversationId: () => this._readWorkspaceLastConversationId(),
        readGlobalAuxPaneConversationIds: () => this._readGlobalAuxPaneConversationIds(),
      },
      summaries,
      byId
    );
  }

  _readWorkspaceLastConversationId() {
    return readWorkspaceLastConversationId(this.workspaceStateDbPath, this._wsStateCache);
  }

  _readGlobalAuxPaneConversationIds() {
    return readGlobalAuxPaneConversationIds(this.globalStateDbPath, this._globalStateCache);
  }

  _loadSummariesWithAnnotations() {
    return loadSummariesWithAnnotations(
      this.antigravityDir,
      this._summariesCache,
      this._annotationsCache
    );
  }

  _getTranscriptPath(conversationId) {
    return getTranscriptPath(this.antigravityDir, conversationId);
  }

  _readTranscriptIncremental(conversationId, filePath) {
    readTranscriptIncremental(this, conversationId, filePath);
  }

  _readTranscriptIntoState(active, existingStat) {
    readTranscriptIntoState(active, existingStat);
  }

  _readTranscriptTailPreview(conversationId, filePath) {
    return readTranscriptTailPreview(this, conversationId, filePath);
  }

  _resolveContextLimitAndDisplayName(conversationId, model, turnCount) {
    return resolveContextLimitAndDisplayName(this, conversationId, model, turnCount);
  }

  _resolvePreviewLimitAndDisplayName(conversationId, model) {
    return resolvePreviewLimitAndDisplayName(this, conversationId, model);
  }

  _attachStaticWatchers() {
    attachStaticWatchers(this);
  }

  _ensureTranscriptWatcher(conversationId, transcriptPath) {
    ensureTranscriptWatcher(this, conversationId, transcriptPath);
  }

  _closeWatcher(propName) {
    closeWatcher(this, propName);
  }

  _scheduleRefresh() {
    scheduleRefresh(this);
  }

  _clearDebounceTimer() {
    clearDebounceTimer(this);
  }

  _syncSafetyTimer() {
    syncSafetyTimer(this);
  }

  _clearSafetyTimer() {
    clearSafetyTimer(this);
  }

  _emitUpdate(force) {
    if (!this.onUpdate) {
      return;
    }
    const serialized = JSON.stringify(this._snapshot);
    if (!force && serialized === this._lastSnapshotJson) {
      return;
    }
    this._lastSnapshotJson = serialized;
    try {
      this.onUpdate(this.getSnapshot());
    } catch {
      // Never allow listener errors to break tracker loop
    }
  }
}

module.exports = {
  TokenTracker,
  DEFAULT_MODEL_LIMITS,
  formatTokenCount,
  getEfficiencyStatus,
};
