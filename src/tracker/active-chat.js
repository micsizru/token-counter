'use strict';

/**
 * Active conversation detection and workspace path normalization helpers.
 * Handles Windows case-insensitive path matching, flush-grace overrides, and aux-pane/recency fallbacks.
 */

const { uriToFsPath } = require('../proto');
const { isSubagentSummary } = require('./summaries');

const VIEW_OVERRIDE_MARGIN_MS = 3000;
const STATE_DB_FLUSH_GRACE_MS = 1000;

/**
 * Normalize a filesystem path or file:// URI for cross-platform workspace comparison.
 *
 * @param {string} input
 * @returns {string}
 */
function normalizePathForCompare(input) {
  if (!input || typeof input !== 'string') {
    return '';
  }
  const fsPath = input.toLowerCase().startsWith('file://') ? uriToFsPath(input) : input;
  let normalized = fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Normalize workspaceFolders input (array of strings or VS Code WorkspaceFolder objects).
 *
 * @param {Array<string | { fsPath?: string, uri?: { fsPath?: string, path?: string } | string }>} folders
 * @returns {string[]}
 */
function normalizeWorkspaceFolders(folders) {
  if (!Array.isArray(folders)) {
    return [];
  }
  const out = [];
  for (const item of folders) {
    let raw = '';
    if (typeof item === 'string') {
      raw = item;
    } else if (item && typeof item === 'object') {
      if (typeof item.fsPath === 'string') {
        raw = item.fsPath;
      } else if (item.uri && typeof item.uri === 'object' && typeof item.uri.fsPath === 'string') {
        raw = item.uri.fsPath;
      } else if (typeof item.uri === 'string') {
        raw = item.uri;
      }
    }
    const norm = normalizePathForCompare(raw);
    if (norm && !out.includes(norm)) {
      out.push(norm);
    }
  }
  return out;
}

/**
 * Detect the active conversation ID using workspace state DB, same-workspace challenger overrides,
 * and global aux-pane / recency fallbacks.
 *
 * @param {{ workspaceFolders?: string[], readWorkspaceLastConversationId?: () => { lastConversationId: string | null, mtimeMs: number }, readGlobalAuxPaneConversationIds?: () => string[] }} ctx
 * @param {Array<object>} summaries
 * @param {Map<string, object>} byId
 * @returns {string | null}
 */
function detectActiveConversationId(ctx, summaries, byId) {
  const workspaceFolders = Array.isArray(ctx && ctx.workspaceFolders) ? ctx.workspaceFolders : [];
  const wsState =
    (ctx && typeof ctx.readWorkspaceLastConversationId === 'function'
      ? ctx.readWorkspaceLastConversationId()
      : null) || { lastConversationId: null, mtimeMs: 0 };
  const hasWorkspace = workspaceFolders.length > 0;

  let primaryId = wsState.lastConversationId;
  if (primaryId) {
    const primarySummary = byId.get(primaryId);
    if (isSubagentSummary(primarySummary)) {
      primaryId = null;
    }
  }

  const nonSubagents = summaries.filter((s) => !isSubagentSummary(s));
  const sameWorkspaceCandidates = hasWorkspace
    ? nonSubagents.filter((s) => {
        const normWs = normalizePathForCompare(s.workspacePath || s.workspaceUri);
        return normWs !== '' && workspaceFolders.includes(normWs);
      })
    : [];

  if (primaryId) {
    // Smoothly handle tab switches inside the SAME workspace before state.vscdb flushes
    if (hasWorkspace && sameWorkspaceCandidates.length > 0) {
      const primarySummary = byId.get(primaryId);
      const primaryActivityMs = primarySummary
        ? Math.max(
            primarySummary.lastUserViewMs || 0,
            primarySummary.lastUserInputMs || 0,
            primarySummary.lastModifiedMs || 0
          )
        : 0;
      const primaryRunning = primarySummary ? primarySummary.status === 'running' : false;

      let challenger = null;
      let challengerScore = 0;

      for (const cand of sameWorkspaceCandidates) {
        if (cand.id === primaryId) {
          continue;
        }
        const candViewMs = cand.lastUserViewMs || 0;
        const candActivityMs = Math.max(
          candViewMs,
          cand.lastUserInputMs || 0,
          cand.lastModifiedMs || 0
        );
        const candRunning = cand.status === 'running';

        const newerThanStateDb =
          wsState.mtimeMs > 0 && candActivityMs > wsState.mtimeMs + STATE_DB_FLUSH_GRACE_MS;

        const runningOverride =
          candRunning &&
          !primaryRunning &&
          candActivityMs >= primaryActivityMs &&
          (newerThanStateDb || wsState.mtimeMs === 0);

        const viewOverride =
          candViewMs > primaryActivityMs + VIEW_OVERRIDE_MARGIN_MS &&
          (wsState.mtimeMs === 0 || candViewMs > wsState.mtimeMs + STATE_DB_FLUSH_GRACE_MS);

        if (runningOverride || viewOverride) {
          const score = (candRunning ? 1e15 : 0) + candActivityMs;
          if (score > challengerScore) {
            challengerScore = score;
            challenger = cand;
          }
        }
      }

      if (challenger) {
        return challenger.id;
      }
    }

    return primaryId;
  }

  // Fallback: no workspaceStateDbPath / empty window / lastConversationId was a subagent
  const rawGlobalPaneIds =
    (ctx && typeof ctx.readGlobalAuxPaneConversationIds === 'function'
      ? ctx.readGlobalAuxPaneConversationIds()
      : null) || [];
  const globalPaneIds = rawGlobalPaneIds.filter((id) => !isSubagentSummary(byId.get(id)));
  const globalPaneSet = new Set(globalPaneIds);

  let pool = [];
  if (hasWorkspace && sameWorkspaceCandidates.length > 0) {
    pool = sameWorkspaceCandidates;
  } else if (!hasWorkspace && globalPaneIds.length > 0) {
    const paneSummaries = nonSubagents.filter((s) => globalPaneSet.has(s.id));
    pool = paneSummaries.length > 0 ? paneSummaries : nonSubagents;
  } else {
    pool = nonSubagents;
  }

  if (pool.length > 0) {
    const ranked = [...pool].sort((a, b) => {
      const aRun = a.status === 'running' ? 1 : 0;
      const bRun = b.status === 'running' ? 1 : 0;
      if (aRun !== bRun) {
        return bRun - aRun;
      }
      const aTime = Math.max(a.lastUserViewMs || 0, a.lastUserInputMs || 0, a.lastModifiedMs || 0);
      const bTime = Math.max(b.lastUserViewMs || 0, b.lastUserInputMs || 0, b.lastModifiedMs || 0);
      return bTime - aTime;
    });
    return ranked[0].id;
  }

  if (globalPaneIds.length > 0) {
    return globalPaneIds[0];
  }

  return null;
}

module.exports = {
  VIEW_OVERRIDE_MARGIN_MS,
  STATE_DB_FLUSH_GRACE_MS,
  normalizePathForCompare,
  normalizeWorkspaceFolders,
  detectActiveConversationId,
};
