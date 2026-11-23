'use strict';

/**
 * @fileoverview Configuration reader and helpers for Token Sayar extension.
 * Provides configuration loading with defaults, equality comparison,
 * workspace folder discovery, and context-key synchronization.
 *
 * Exports:
 * - readConfig(vscode)
 * - configsEqual(a, b)
 * - getWorkspaceFolderPaths(vscode)
 * - syncEnabledContext(vscode, enabled)
 */

function getVs(vscodeInstance) {
  if (vscodeInstance) {
    return vscodeInstance;
  }
  try {
    return require('vscode');
  } catch {
    return null;
  }
}

/**
 * Reads tokenSayar extension configuration with fallbacks.
 * @param {object} [vscodeInstance]
 * @returns {object} Normalized configuration object.
 */
function readConfig(vscodeInstance) {
  const vs = getVs(vscodeInstance);
  if (!vs || !vs.workspace) {
    return {
      enabled: true,
      warnPercent: 55,
      dangerPercent: 80,
      defaultContextLimit: 512000,
      compactDisplay: false,
      statusBarClickAction: 'openPanel',
      modelLimits: {},
      notifications: true,
    };
  }

  const cfg = vs.workspace.getConfiguration('tokenSayar');
  const rawModelLimits = cfg.get('modelLimits', {});
  const modelLimits =
    rawModelLimits && typeof rawModelLimits === 'object' && !Array.isArray(rawModelLimits)
      ? rawModelLimits
      : {};

  const rawClickAction = cfg.get('statusBarClickAction', 'openPanel');
  const statusBarClickAction = rawClickAction === 'openMenu' ? 'openMenu' : 'openPanel';

  return {
    enabled: Boolean(cfg.get('enabled', true)),
    warnPercent: Number(cfg.get('warnPercent', 55)) || 55,
    dangerPercent: Number(cfg.get('dangerPercent', 80)) || 80,
    defaultContextLimit: Number(cfg.get('defaultContextLimit', 512000)) || 512000,
    compactDisplay: Boolean(cfg.get('compactDisplay', false)),
    statusBarClickAction,
    modelLimits,
    notifications: Boolean(cfg.get('notifications', true)),
  };
}

/**
 * Compares two configuration objects for functional equality.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function configsEqual(a, b) {
  if (!a || !b) {
    return false;
  }
  return (
    a.enabled === b.enabled &&
    a.warnPercent === b.warnPercent &&
    a.dangerPercent === b.dangerPercent &&
    a.defaultContextLimit === b.defaultContextLimit &&
    a.compactDisplay === b.compactDisplay &&
    a.statusBarClickAction === b.statusBarClickAction &&
    a.notifications === b.notifications &&
    JSON.stringify(a.modelLimits || {}) === JSON.stringify(b.modelLimits || {})
  );
}

/**
 * Returns absolute fsPaths of all current workspace folders.
 * @param {object} [vscodeInstance]
 * @returns {string[]}
 */
function getWorkspaceFolderPaths(vscodeInstance) {
  const vs = getVs(vscodeInstance);
  return (vs && vs.workspace && vs.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

/**
 * Sets VS Code context key tokenSayar.enabled for when-clause gating.
 * @param {object} [vscodeInstance]
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
function syncEnabledContext(vscodeInstance, enabled) {
  const vs = getVs(vscodeInstance);
  if (!vs || !vs.commands) {
    return Promise.resolve();
  }
  return Promise.resolve(
    vs.commands.executeCommand('setContext', 'tokenSayar.enabled', Boolean(enabled))
  ).catch(() => {});
}

module.exports = {
  readConfig,
  configsEqual,
  getWorkspaceFolderPaths,
  syncEnabledContext,
};
