'use strict';

/**
 * Shared formatting, tier-mapping, tooltip, and TreeItem helpers for Token Sayar views
 * and status bar presentation.
 *
 * Exports:
 * - TIER_MAP, LIMIT_SOURCE_LABELS
 * - getTierInfo, getTierLabel
 * - safeFormatTokens, trTokens, trDecimal, trRawInt
 * - truncateText, formatClockHMS, formatClockHM, formatRelativeTime
 * - buildThresholdBar, makeMarkdownTooltip, makeTextTooltip, makeTreeItem
 * - extractConversationId, escapeMarkdown, mapStatusLabel, resolveConversationTitle
 */

const { formatTokenCount, getEfficiencyStatus } = require('../tracker/metrics');

const TIER_MAP = Object.freeze({
  none: {
    label: 'Veri yok',
    color: 'disabledForeground',
    advice: 'Henüz okunabilir token verisi bulunmuyor.',
  },
  excellent: {
    label: 'Sağlıklı',
    color: 'charts.green',
    advice: 'Bağlam kullanımı sağlıklı aralıkta, model önceki adımları net biçimde koruyor.',
  },
  good: {
    label: 'Sağlıklı',
    color: 'charts.green',
    advice: 'Bağlam kullanımı sağlıklı aralıkta, model önceki adımları net biçimde koruyor.',
  },
  degrading: {
    label: 'Dolmaya başladı',
    color: 'charts.yellow',
    advice: 'Bağlam dolmaya başladı, yanıt kalitesi kademeli olarak düşebilir.',
  },
  low: {
    label: 'Dolu, sıkıştırma önerilir',
    color: 'charts.orange',
    advice: 'Bağlam büyük ölçüde doldu, sıkıştırma veya yeni sohbet önerilir.',
  },
  critical: {
    label: 'Kritik, yeni sohbet önerilir',
    color: 'charts.red',
    advice: 'Otomatik sıkıştırma eşiğine çok yaklaşıldı, yeni bir sohbet başlatmak daha verimlidir.',
  },
});

const LIMIT_SOURCE_LABELS = Object.freeze({
  db: 'Antigravity sohbet verisi',
  'model-table': 'Model tablosu',
  default: 'Varsayılan ayar',
});

function getTierInfo(percent, bloatLevel, config) {
  const status = getEfficiencyStatus(percent, bloatLevel, config);
  const tier = status && status.tier ? status.tier : 'none';
  return TIER_MAP[tier] || TIER_MAP.none;
}

function getTierLabel(percent, bloatLevel, config) {
  if (typeof getEfficiencyStatus === 'function') {
    const eff = getEfficiencyStatus(percent, bloatLevel, config);
    switch (eff && eff.tier) {
      case 'excellent':
      case 'good':
        return 'Sağlıklı';
      case 'degrading':
        return 'Dolmaya başladı';
      case 'low':
        return 'Dolu, sıkıştırma önerilir';
      case 'critical':
        return 'Kritik, yeni sohbet önerilir';
      default:
        return 'Veri yok';
    }
  }
  switch (bloatLevel) {
    case 'ok':
      return 'Sağlıklı';
    case 'warn':
      return 'Dolmaya başladı';
    case 'danger':
      return 'Dolu, sıkıştırma önerilir';
    default:
      return 'Veri yok';
  }
}

function safeFormatTokens(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return '0';
  }
  if (typeof formatTokenCount === 'function') {
    return formatTokenCount(num);
  }
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(num >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  }
  return String(Math.round(num));
}

function trTokens(value) {
  return safeFormatTokens(value).replace(/\./g, ',');
}

function trDecimal(value, digits = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return (0).toFixed(digits).replace('.', ',');
  }
  return num.toFixed(digits).replace('.', ',');
}

function trRawInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return '0';
  }
  return Math.round(num).toLocaleString('tr-TR');
}

function truncateText(text, maxLen) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return normalized.slice(0, Math.max(1, maxLen - 1)) + '…';
}

function formatClockHMS(timestamp) {
  if (!timestamp) {
    return '—';
  }
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(d.getTime())) {
    return '—';
  }
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatClockHM(timestamp) {
  if (!timestamp) {
    return '';
  }
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatRelativeTime(ms) {
  const num = Number(ms);
  if (!Number.isFinite(num) || num <= 0) {
    return 'Bilinmiyor';
  }
  const diffSec = Math.max(0, Math.floor((Date.now() - num) / 1000));
  if (diffSec < 60) {
    return 'az önce';
  }
  if (diffSec < 3600) {
    return `${Math.floor(diffSec / 60)} dk önce`;
  }
  if (diffSec < 86400) {
    return `${Math.floor(diffSec / 3600)} sa önce`;
  }
  return `${Math.floor(diffSec / 86400)} gün önce`;
}

function buildThresholdBar(percent, warnPercent = 55, dangerPercent = 80) {
  const filledCount = Math.min(20, Math.max(0, Math.round((Number(percent) || 0) / 5)));
  const cells = [];
  for (let i = 0; i < 20; i += 1) {
    cells.push(i < filledCount ? '▰' : '▱');
  }
  let warnIdx = Math.min(19, Math.max(0, Math.round((Number(warnPercent) || 55) / 5) - 1));
  const dangerIdx = Math.min(19, Math.max(0, Math.round((Number(dangerPercent) || 80) / 5) - 1));
  if (warnIdx === dangerIdx) {
    warnIdx = Math.max(0, dangerIdx - 1);
  }
  cells[warnIdx] = '│';
  cells[dangerIdx] = '┃';
  return cells.join('');
}

function makeMarkdownTooltip(vscode, buildFn) {
  if (vscode && typeof vscode.MarkdownString === 'function') {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = false;
    buildFn(md);
    return md;
  }
  const parts = [];
  buildFn({
    appendText: (text) => parts.push(String(text || '')),
    appendMarkdown: (text) => parts.push(String(text || '')),
  });
  return parts.join('');
}

function makeTextTooltip(vscode, text) {
  return makeMarkdownTooltip(vscode, (md) => {
    md.appendText(text);
  });
}

function makeTreeItem(vscode, opts) {
  const item = new vscode.TreeItem(
    opts.label,
    opts.collapsibleState !== undefined
      ? opts.collapsibleState
      : vscode.TreeItemCollapsibleState.None
  );
  if (opts.id !== undefined) {
    item.id = opts.id;
  }
  if (opts.description !== undefined) {
    item.description = opts.description;
  }
  if (opts.tooltip !== undefined) {
    item.tooltip = opts.tooltip;
  }
  if (opts.iconPath !== undefined) {
    item.iconPath = opts.iconPath;
  }
  if (opts.contextValue !== undefined) {
    item.contextValue = opts.contextValue;
  }
  if (opts.command !== undefined) {
    item.command = opts.command;
  }
  if (opts._children !== undefined) {
    item._children = opts._children;
  }
  return item;
}

function extractConversationId(arg) {
  if (typeof arg === 'string') {
    return arg.trim() || null;
  }
  if (arg && typeof arg === 'object') {
    const raw = arg.conversationId || arg.id;
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
  }
  return null;
}

function escapeMarkdown(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/([*_`[\]<>])/g, '\\$1');
}

function mapStatusLabel(status) {
  if (!status) {
    return 'Beklemede';
  }
  const normalized = String(status).toLowerCase();
  if (
    normalized === 'running' ||
    normalized === 'active' ||
    normalized === 'in_progress' ||
    normalized === 'streaming'
  ) {
    return 'Çalışıyor';
  }
  if (normalized === 'idle' || normalized === 'waiting' || normalized === 'paused') {
    return 'Beklemede';
  }
  if (normalized === 'completed' || normalized === 'done' || normalized === 'finished') {
    return 'Tamamlandı';
  }
  if (normalized === 'error' || normalized === 'failed') {
    return 'Hata';
  }
  if (normalized === 'unknown') {
    return 'Bilinmiyor';
  }
  return String(status);
}

function resolveConversationTitle(snapshot) {
  if (!snapshot) {
    return 'Token Sayar';
  }
  if (snapshot.title) {
    return String(snapshot.title);
  }
  if (snapshot.conversationId) {
    return `Sohbet ${String(snapshot.conversationId).slice(0, 8)}`;
  }
  return 'Token Sayar';
}

module.exports = {
  TIER_MAP,
  LIMIT_SOURCE_LABELS,
  getTierInfo,
  getTierLabel,
  safeFormatTokens,
  trTokens,
  trDecimal,
  trRawInt,
  truncateText,
  formatClockHMS,
  formatClockHM,
  formatRelativeTime,
  buildThresholdBar,
  makeMarkdownTooltip,
  makeTextTooltip,
  makeTreeItem,
  extractConversationId,
  escapeMarkdown,
  mapStatusLabel,
  resolveConversationTitle,
};
