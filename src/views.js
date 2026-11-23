'use strict';

/**
 * Orchestrator for Token Sayar TreeViews (`tokenSayar.context` and `tokenSayar.timeline`),
 * view commands, snapshot debouncing, and lifecycle management.
 *
 * Delegates rendering and command workflows to `src/views/*` modules.
 *
 * Exports:
 * - TokenSayarViews
 * - VIEW_IDS
 * - buildThresholdBar
 */

const { buildThresholdBar, extractConversationId } = require('./views/format');
const { buildContextChildren } = require('./views/context-view');
const { buildTimelineChildren } = require('./views/timeline-view');
const { showConversationPicker } = require('./views/conversation-picker');
const { exportConversationReport } = require('./views/report-exporter');

const VIEW_IDS = Object.freeze({
  context: 'tokenSayar.context',
  timeline: 'tokenSayar.timeline',
});

const DEBOUNCE_MS = 250;

class TokenSayarViews {
  constructor({ vscode, tracker, extensionUri, getConfig } = {}) {
    this._vscode = vscode;
    this._tracker = tracker;
    this._extensionUri = extensionUri;
    this._getConfig = typeof getConfig === 'function' ? getConfig : () => ({});

    this._inspectedId = null;
    this._lastSnapshot = null;
    this._debounceTimer = null;
    this._disposed = false;

    this._contextEmitter = null;
    this._timelineEmitter = null;

    this._contextView = null;
    this._timelineView = null;

    this._disposables = [];
  }

  register() {
    const vscode = this._vscode;

    this._contextEmitter = new vscode.EventEmitter();
    this._timelineEmitter = new vscode.EventEmitter();

    const contextProvider = {
      onDidChangeTreeData: this._contextEmitter.event,
      getTreeItem: (element) => element,
      getChildren: (element) => this._getContextChildren(element),
    };

    const timelineProvider = {
      onDidChangeTreeData: this._timelineEmitter.event,
      getTreeItem: (element) => element,
      getChildren: (element) => this._getTimelineChildren(element),
    };

    this._contextView = vscode.window.createTreeView(VIEW_IDS.context, {
      treeDataProvider: contextProvider,
      showCollapseAll: false,
    });
    this._timelineView = vscode.window.createTreeView(VIEW_IDS.timeline, {
      treeDataProvider: timelineProvider,
      showCollapseAll: true,
    });

    const visContext = this._contextView.onDidChangeVisibility((e) => {
      if (e && e.visible && !this._disposed) {
        this._contextEmitter.fire();
      }
    });
    const visTimeline = this._timelineView.onDidChangeVisibility((e) => {
      if (e && e.visible && !this._disposed) {
        this._timelineEmitter.fire();
      }
    });

    const cmdSelectConversation = vscode.commands.registerCommand(
      'tokenSayar.selectConversation',
      async () => this._handleSelectConversation()
    );

    const cmdFollowActive = vscode.commands.registerCommand(
      'tokenSayar.followActive',
      () => {
        this._inspectedId = null;
        this._syncInspectingContext();
        this._refreshVisibleViews();
      }
    );

    const cmdInspectConversation = vscode.commands.registerCommand(
      'tokenSayar.inspectConversation',
      (arg) => {
        const id = extractConversationId(arg);
        if (!id) {
          return;
        }
        const snap = this._lastSnapshot || (this._tracker ? this._tracker.getSnapshot() : null);
        const isArgActiveAuto = Boolean(arg && typeof arg === 'object' && arg.isActiveAuto);
        const isSnapActiveAuto = Boolean(
          snap && snap.mode === 'auto' && snap.conversationId === id
        );
        if (isSnapActiveAuto || (isArgActiveAuto && (!snap || snap.mode === 'auto'))) {
          this._inspectedId = null;
        } else {
          this._inspectedId = id;
        }
        this._syncInspectingContext();
        this._refreshVisibleViews();
      }
    );

    const cmdCopyValue = vscode.commands.registerCommand(
      'tokenSayar.copyValue',
      async (item) => {
        if (!item) {
          return;
        }
        const label = item.label != null ? String(item.label) : '';
        const desc =
          item.description !== undefined && item.description !== null && item.description !== ''
            ? String(item.description)
            : '';
        const text = desc ? `${label}: ${desc}` : label;
        if (!text) {
          return;
        }
        await vscode.env.clipboard.writeText(text);
      }
    );

    const cmdShowHelp = vscode.commands.registerCommand(
      'tokenSayar.showHelp',
      async () => {
        const uri = vscode.Uri.joinPath(this._extensionUri, 'media', 'help.md');
        try {
          await vscode.commands.executeCommand('markdown.showPreview', uri);
        } catch {
          await vscode.window.showTextDocument(uri);
        }
      }
    );

    const cmdOpenPanel = vscode.commands.registerCommand(
      'tokenSayar.openPanel',
      async () => {
        await vscode.commands.executeCommand(`${VIEW_IDS.context}.focus`);
      }
    );

    const cmdOpenTimeline = vscode.commands.registerCommand(
      'tokenSayar.openTimeline',
      async () => {
        await vscode.commands.executeCommand(`${VIEW_IDS.timeline}.focus`);
      }
    );

    const cmdPinToStatusBar = vscode.commands.registerCommand(
      'tokenSayar.pinToStatusBar',
      (item) => {
        const id = extractConversationId(item);
        if (!id || !this._tracker) {
          return;
        }
        this._tracker.setPinnedConversation(id);
        this._tracker.refresh();
        this._refreshVisibleViews();
      }
    );

    const cmdUnpinStatusBar = vscode.commands.registerCommand(
      'tokenSayar.unpinStatusBar',
      () => {
        if (!this._tracker) {
          return;
        }
        this._tracker.setPinnedConversation(null);
        this._tracker.refresh();
        this._refreshVisibleViews();
      }
    );

    const cmdExportReport = vscode.commands.registerCommand(
      'tokenSayar.exportReport',
      async () => this._handleExportReport()
    );

    this._syncInspectingContext();

    this._disposables = [
      this._contextEmitter,
      this._timelineEmitter,
      this._contextView,
      this._timelineView,
      visContext,
      visTimeline,
      cmdSelectConversation,
      cmdFollowActive,
      cmdInspectConversation,
      cmdCopyValue,
      cmdShowHelp,
      cmdOpenPanel,
      cmdOpenTimeline,
      cmdPinToStatusBar,
      cmdUnpinStatusBar,
      cmdExportReport,
    ];

    return [...this._disposables];
  }

  onSnapshot(snap) {
    if (this._disposed) {
      return;
    }
    this._lastSnapshot = snap || null;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      if (!this._disposed) {
        this._refreshVisibleViews();
      }
    }, DEBOUNCE_MS);
  }

  onConfigChanged() {
    if (this._disposed) {
      return;
    }
    this._refreshVisibleViews();
  }

  getInspectedId() {
    return this._inspectedId;
  }

  dispose() {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    for (const d of this._disposables) {
      if (d && typeof d.dispose === 'function') {
        try {
          d.dispose();
        } catch {
          // Ignore dispose errors
        }
      }
    }
    this._disposables = [];
    this._contextView = null;
    this._timelineView = null;
    this._contextEmitter = null;
    this._timelineEmitter = null;
  }

  _syncInspectingContext() {
    if (!this._vscode || !this._vscode.commands) {
      return;
    }
    Promise.resolve(
      this._vscode.commands.executeCommand(
        'setContext',
        'tokenSayar.inspecting',
        Boolean(this._inspectedId)
      )
    ).catch(() => {});
  }

  _refreshVisibleViews() {
    if (this._contextView && this._contextView.visible && this._contextEmitter) {
      this._contextEmitter.fire();
    }
    if (this._timelineView && this._timelineView.visible && this._timelineEmitter) {
      this._timelineEmitter.fire();
    }
  }

  _getTargetSnapshot() {
    if (this._inspectedId) {
      return this._tracker ? this._tracker.inspectConversation(this._inspectedId) : null;
    }
    return this._lastSnapshot || (this._tracker ? this._tracker.getSnapshot() : null);
  }

  _getViewContext() {
    return {
      vscode: this._vscode,
      tracker: this._tracker,
      contextView: this._contextView,
      timelineView: this._timelineView,
      getConfig: () => this._getConfig(),
      getTargetSnapshot: () => this._getTargetSnapshot(),
      getInspectedId: () => this._inspectedId,
      setInspectedId: (id) => {
        this._inspectedId = id;
      },
      syncInspectingContext: () => this._syncInspectingContext(),
      refreshVisibleViews: () => this._refreshVisibleViews(),
    };
  }

  _getContextChildren(element) {
    return buildContextChildren(this._getViewContext(), element);
  }

  _getTimelineChildren(element) {
    return buildTimelineChildren(this._getViewContext(), element);
  }

  async _handleSelectConversation() {
    return showConversationPicker(this._getViewContext());
  }

  async _handleExportReport() {
    return exportConversationReport(this._getViewContext());
  }
}

module.exports = {
  TokenSayarViews,
  VIEW_IDS,
  buildThresholdBar,
};
