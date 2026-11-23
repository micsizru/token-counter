'use strict';

/**
 * @fileoverview Main VS Code extension entry point for Token Sayar.
 * Coordinates token tracker, views, status bar, notifications, and commands.
 *
 * Exports:
 * - activate(context)
 * - deactivate()
 */

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const {
  readConfig,
  configsEqual,
  getWorkspaceFolderPaths,
  syncEnabledContext,
} = require('./extension/config');
const {
  renderStatusBar,
  maybeNotifyDanger,
  showQuickMenu,
} = require('./extension/status-bar');
const { TokenTracker } = require('./tracker');
const { TokenSayarViews } = require('./views');

let activeTracker = null;
let activeViews = null;
let activeNotifiedDanger = null;

/**
 * Activates the Token Sayar extension.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  let currentConfig = readConfig(vscode);
  const notifiedDangerConversations = new Set();
  activeNotifiedDanger = notifiedDangerConversations;

  const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity');
  const workspaceStateDbPath = context.storageUri
    ? path.join(path.dirname(context.storageUri.fsPath), 'state.vscdb')
    : null;
  const globalStateDbPath = context.globalStorageUri
    ? path.join(path.dirname(context.globalStorageUri.fsPath), 'state.vscdb')
    : null;

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  statusBarItem.name = 'Token Sayar (Antigravity)';
  statusBarItem.command = 'tokenSayar.statusBarClick';

  let views = null;

  const tracker = new TokenTracker({
    antigravityDir,
    workspaceStateDbPath,
    globalStateDbPath,
    workspaceFolders: getWorkspaceFolderPaths(vscode),
    config: currentConfig,
    onUpdate: (snapshot) => {
      renderStatusBar(statusBarItem, snapshot, currentConfig);
      maybeNotifyDanger(vscode, snapshot, currentConfig, notifiedDangerConversations);
      if (views) {
        views.onSnapshot(snapshot);
      }
    },
  });
  activeTracker = tracker;
  tracker.setWindowFocused(Boolean(vscode.window.state && vscode.window.state.focused));

  views = new TokenSayarViews({
    vscode,
    tracker,
    extensionUri: context.extensionUri,
    getConfig: () => currentConfig,
  });
  activeViews = views;
  const viewDisposables = views.register() || [];

  async function setEnabled(nextEnabled) {
    const cfg = vscode.workspace.getConfiguration('tokenSayar');
    const inspected = cfg.inspect('enabled');
    const target =
      inspected && inspected.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    const normalizedNext = Boolean(nextEnabled);
    currentConfig = { ...currentConfig, enabled: normalizedNext };
    syncEnabledContext(vscode, normalizedNext);
    tracker.setWindowFocused(Boolean(vscode.window.state && vscode.window.state.focused));
    tracker.updateConfig(currentConfig);
    renderStatusBar(statusBarItem, tracker.getSnapshot(), currentConfig);
    views.onConfigChanged();

    await cfg.update('enabled', normalizedNext, target);
  }

  const cmdPause = vscode.commands.registerCommand('tokenSayar.pause', async () => {
    await setEnabled(false);
    vscode.window.setStatusBarMessage('Token Sayar duraklatıldı.', 3000);
  });

  const cmdResume = vscode.commands.registerCommand('tokenSayar.resume', async () => {
    await setEnabled(true);
    vscode.window.setStatusBarMessage('Token Sayar başlatıldı.', 3000);
  });

  const cmdToggle = vscode.commands.registerCommand('tokenSayar.toggle', async () => {
    const nextEnabled = !currentConfig.enabled;
    await setEnabled(nextEnabled);
    vscode.window.setStatusBarMessage(
      nextEnabled ? 'Token Sayar başlatıldı.' : 'Token Sayar duraklatıldı.',
      3000
    );
  });

  const cmdRefresh = vscode.commands.registerCommand('tokenSayar.refresh', async () => {
    if (!currentConfig.enabled) {
      vscode.window.setStatusBarMessage('Token Sayar duraklatıldı. Yenilemek için takibi sürdürün.', 3000);
      return;
    }
    await Promise.resolve(tracker.refresh());
    const snap = tracker.getSnapshot();
    renderStatusBar(statusBarItem, snap, currentConfig);
    maybeNotifyDanger(vscode, snap, currentConfig, notifiedDangerConversations);
    views.onSnapshot(snap);
  });

  const cmdOpenSettings = vscode.commands.registerCommand('tokenSayar.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'tokenSayar');
  });

  const cmdOpenMenu = vscode.commands.registerCommand('tokenSayar.openMenu', async () => {
    await showQuickMenu({
      vscode,
      tracker,
      getConfig: () => currentConfig,
    });
  });

  const cmdStatusBarClick = vscode.commands.registerCommand('tokenSayar.statusBarClick', async () => {
    if (currentConfig.statusBarClickAction === 'openMenu') {
      await vscode.commands.executeCommand('tokenSayar.openMenu');
      return;
    }
    await vscode.commands.executeCommand('tokenSayar.openPanel');
  });

  const windowStateDisposable = vscode.window.onDidChangeWindowState((state) => {
    tracker.setWindowFocused(Boolean(state.focused));
  });

  const workspaceFoldersDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    tracker.updateWorkspaceFolders(getWorkspaceFolderPaths(vscode));
    views.onSnapshot(tracker.getSnapshot());
  });

  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('tokenSayar')) {
      return;
    }
    const nextConfig = readConfig(vscode);
    if (configsEqual(currentConfig, nextConfig)) {
      return;
    }
    currentConfig = nextConfig;
    syncEnabledContext(vscode, currentConfig.enabled);
    tracker.setWindowFocused(Boolean(vscode.window.state && vscode.window.state.focused));
    tracker.updateConfig(currentConfig);
    renderStatusBar(statusBarItem, tracker.getSnapshot(), currentConfig);
    views.onConfigChanged();
  });

  const trackerDisposable = {
    dispose: () => {
      notifiedDangerConversations.clear();
      if (activeNotifiedDanger === notifiedDangerConversations) {
        activeNotifiedDanger = null;
      }
      if (activeViews) {
        activeViews.dispose();
        activeViews = null;
      }
      if (activeTracker) {
        activeTracker.dispose();
        activeTracker = null;
      }
    },
  };

  context.subscriptions.push(
    statusBarItem,
    ...viewDisposables,
    cmdStatusBarClick,
    cmdPause,
    cmdResume,
    cmdToggle,
    cmdRefresh,
    cmdOpenSettings,
    cmdOpenMenu,
    windowStateDisposable,
    workspaceFoldersDisposable,
    configDisposable,
    trackerDisposable
  );

  syncEnabledContext(vscode, currentConfig.enabled);
  if (currentConfig.enabled) {
    tracker.start();
  }
  const initialSnapshot = tracker.getSnapshot();
  renderStatusBar(statusBarItem, initialSnapshot, currentConfig);
  maybeNotifyDanger(vscode, initialSnapshot, currentConfig, notifiedDangerConversations);
  views.onSnapshot(initialSnapshot);
}

/**
 * Deactivates the Token Sayar extension and releases all resources.
 */
function deactivate() {
  if (activeNotifiedDanger) {
    activeNotifiedDanger.clear();
    activeNotifiedDanger = null;
  }
  if (activeViews) {
    try {
      activeViews.dispose();
    } finally {
      activeViews = null;
    }
  }
  if (activeTracker) {
    try {
      activeTracker.dispose();
    } finally {
      activeTracker = null;
    }
  }
}

module.exports = {
  activate,
  deactivate,
};
