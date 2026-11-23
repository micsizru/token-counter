'use strict';

/**
 * @fileoverview Status bar renderer, tooltip builder, clipboard summary,
 * danger notification, and quick menu actions for Token Sayar extension.
 *
 * Exports:
 * - buildTooltip(snapshot, config)
 * - buildClipboardSummary(snapshot, config)
 * - renderStatusBar(statusBarItem, snapshot, config)
 * - maybeNotifyDanger(vscode, snapshot, config, notifiedDangerConversations)
 * - showQuickMenu(ctx)
 */

const {
  safeFormatTokens,
  trTokens,
  trDecimal,
  trRawInt,
  escapeMarkdown,
  mapStatusLabel,
  getTierLabel,
  resolveConversationTitle,
} = require('../views/format');
const { getEfficiencyStatus } = require('../tracker/metrics');

let vscodeModule = null;
try {
  vscodeModule = require('vscode');
} catch {
  // vscode is provided by VS Code host or test mocks
}

class FallbackThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class FallbackMarkdownString {
  constructor(value = '', supportThemeIcons = true) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
    this.isTrusted = false;
  }

  appendMarkdown(str) {
    this.value += String(str == null ? '' : str);
    return this;
  }

  appendText(str) {
    this.value += String(str == null ? '' : str);
    return this;
  }
}

function getVscode(override) {
  return override || vscodeModule;
}

/**
 * Builds markdown tooltip for the status bar indicator.
 * @param {object} snapshot
 * @param {object} config
 * @returns {object} MarkdownString instance
 */
function buildTooltip(snapshot, config) {
  const vs = getVscode();
  const md =
    vs && typeof vs.MarkdownString === 'function'
      ? new vs.MarkdownString('', true)
      : new FallbackMarkdownString('', true);
  md.isTrusted = false;

  const cfg = config || {};
  const isDisabled = !cfg.enabled || (snapshot && snapshot.enabled === false);
  if (isDisabled) {
    md.appendMarkdown('**Token Sayar**\n\n');
    md.appendMarkdown('Takip duraklatıldı.\n\n');
    md.appendMarkdown('Açmak için tıklayın.');
    return md;
  }

  const snap = snapshot || {};
  const title = escapeMarkdown(resolveConversationTitle(snap));

  const hasData =
    snap.bloatLevel &&
    snap.bloatLevel !== 'none' &&
    Number.isFinite(Number(snap.contextLimit)) &&
    Number(snap.contextLimit) > 0;

  if (!hasData) {
    md.appendMarkdown(`**${title}**\n\n`);
    md.appendMarkdown('Bağlam: Veri yok\n\n');
    md.appendMarkdown('Ayrıntılar için tıklayın.');
    return md;
  }

  const contextTokens = Number(snap.contextTokens) || 0;
  const contextLimit = Number(snap.contextLimit) || cfg.defaultContextLimit || 512000;
  const percent = Number.isFinite(Number(snap.percent))
    ? Number(snap.percent)
    : (contextTokens / contextLimit) * 100;

  const usedStr = trTokens(contextTokens);
  const limitStr = trTokens(contextLimit);
  const pctStr = trDecimal(percent, 1);
  const tier = getTierLabel(percent, snap.bloatLevel, cfg);
  const tierLabel = typeof tier === 'object' && tier ? tier.label || 'Veri yok' : tier;
  const remStr = trTokens(Math.max(0, contextLimit - contextTokens));

  const modelLabel = escapeMarkdown(snap.modelDisplayName || snap.model || 'Bilinmiyor');
  const modelsSuffix =
    Array.isArray(snap.modelsUsed) && snap.modelsUsed.length > 1
      ? ` (${snap.modelsUsed.length} model)`
      : '';

  md.appendMarkdown(`**${title}**  \n`);
  md.appendMarkdown(`Bağlam: ${usedStr} / ${limitStr} (%${pctStr}), ${tierLabel}  \n`);
  md.appendMarkdown(`Model: ${modelLabel}${modelsSuffix}  \n`);
  md.appendMarkdown(`Kalan: ${remStr}\n\n`);
  md.appendMarkdown('Ayrıntılar için tıklayın.');
  return md;
}

/**
 * Builds clipboard summary text for copying current conversation state.
 * @param {object} snapshot
 * @param {object} config
 * @returns {string}
 */
function buildClipboardSummary(snapshot, config) {
  const cfg = config || {};
  if (!cfg.enabled || (snapshot && snapshot.enabled === false)) {
    return 'Token Sayar (Antigravity): Kapalı';
  }
  const snap = snapshot || {};
  if (!snap.bloatLevel || snap.bloatLevel === 'none') {
    return `Token Sayar (Antigravity): Veri yok${snap.title ? ` (${snap.title})` : ''}`;
  }

  const contextTokens = Number(snap.contextTokens) || 0;
  const contextLimit = Number(snap.contextLimit) || cfg.defaultContextLimit || 512000;
  const percent = Number.isFinite(Number(snap.percent))
    ? Number(snap.percent)
    : contextLimit > 0
      ? (contextTokens / contextLimit) * 100
      : 0;
  const totalInWithCache = (Number(snap.totalInputTokens) || 0) + (Number(snap.totalCacheReadTokens) || 0);
  const totalOutput = Number(snap.totalOutputTokens) || 0;
  const tier = getTierLabel(percent, snap.bloatLevel, cfg);
  const tierLabel = typeof tier === 'object' && tier ? tier.label || 'Veri yok' : tier;

  return [
    'Token Sayar (Antigravity)',
    `Sohbet: ${snap.title || snap.conversationId || '-'} (${snap.mode === 'pinned' ? 'Sabitli' : 'Otomatik'})`,
    `Durum: ${mapStatusLabel(snap.status)} | Model: ${snap.modelDisplayName || snap.model || 'Bilinmiyor'}`,
    `Bağlam: ${trRawInt(contextTokens)} / ${trRawInt(contextLimit)} (%${trDecimal(percent, 1)}) — ${tierLabel}`,
    `Son Tur: Yeni Girdi ${trRawInt(snap.lastInputTokens)} | Önbellek ${trRawInt(snap.lastCacheReadTokens)} | Çıktı ${trRawInt(snap.lastOutputTokens)}`,
    `Toplam Oturum: Girdi+Önbellek ${trRawInt(totalInWithCache)} | Çıktı ${trRawInt(totalOutput)} | ${Number(snap.turnCount) || 0} tur | ${Number(snap.compactionCount) || 0} sıkıştırma`,
  ].join('\n');
}

/**
 * Renders status bar item text, background color, and tooltip.
 * @param {object} statusBarItem
 * @param {object} snapshot
 * @param {object} config
 */
function renderStatusBar(statusBarItem, snapshot, config) {
  if (!statusBarItem) {
    return;
  }
  const cfg = config || {};
  const snap = snapshot || null;
  const isDisabled = !cfg.enabled || (snap && snap.enabled === false);

  if (isDisabled) {
    statusBarItem.text = '$(circle-slash) Token: Kapalı';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = buildTooltip(snap, cfg);
    statusBarItem.show();
    return;
  }

  const pinSuffix = snap && snap.mode === 'pinned' ? ' $(pin)' : '';
  const bloatLevel = snap && snap.bloatLevel ? snap.bloatLevel : 'none';

  if (bloatLevel === 'none' || !snap || !Number.isFinite(Number(snap.contextTokens))) {
    statusBarItem.text = `$(pulse) Token: —${pinSuffix}`;
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = buildTooltip(snap, cfg);
    statusBarItem.show();
    return;
  }

  const usedText = trTokens(snap.contextTokens);
  const limitText = trTokens(snap.contextLimit || cfg.defaultContextLimit || 512000);
  const pctRounded = Math.round(Number(snap.percent) || 0);
  const body = cfg.compactDisplay
    ? `${usedText} (%${pctRounded})`
    : `${usedText} / ${limitText} (%${pctRounded})`;

  let icon = '$(pulse)';
  let bgColor = undefined;

  const vs = getVscode();
  const ThemeColor = (vs && vs.ThemeColor) || FallbackThemeColor;

  if (bloatLevel === 'warn') {
    icon = '$(warning)';
    bgColor = new ThemeColor('statusBarItem.warningBackground');
  } else if (bloatLevel === 'danger') {
    icon = '$(flame)';
    bgColor = new ThemeColor('statusBarItem.errorBackground');
  }

  statusBarItem.text = `${icon} ${body}${pinSuffix}`;
  statusBarItem.backgroundColor = bgColor;
  statusBarItem.tooltip = buildTooltip(snap, cfg);
  statusBarItem.show();
}

/**
 * Notifies user if conversation context exceeds danger threshold.
 * Fires at most once per conversationId.
 * @param {object} vscodeInstance
 * @param {object} snapshot
 * @param {object} config
 * @param {Set<string>} notifiedDangerConversations
 * @returns {Promise<void>}
 */
function maybeNotifyDanger(vscodeInstance, snapshot, config, notifiedDangerConversations) {
  const vs = vscodeInstance || getVscode();
  if (!vs || !vs.window) {
    return Promise.resolve();
  }
  const cfg = config || {};
  const snap = snapshot;
  const notified = notifiedDangerConversations;

  if (
    cfg.enabled &&
    cfg.notifications &&
    snap &&
    snap.conversationId &&
    snap.hasTranscript &&
    snap.percent != null &&
    snap.percent >= cfg.dangerPercent &&
    notified &&
    !notified.has(snap.conversationId)
  ) {
    notified.add(snap.conversationId);
    const ctxLimit = snap.contextLimit || cfg.defaultContextLimit || 512000;
    return Promise.resolve(
      vs.window.showWarningMessage(
        `Token Sayar: Sohbet bağlamı %${Math.round(snap.percent)} doluluğa ulaştı (${trTokens(
          snap.contextTokens
        )} / ${trTokens(ctxLimit)}).`,
        'Görünümü Aç'
      )
    )
      .then((choice) => {
        if (choice === 'Görünümü Aç' && vs.commands) {
          return vs.commands.executeCommand('tokenSayar.openPanel');
        }
      })
      .catch(() => {});
  }
  return Promise.resolve();
}

/**
 * Shows the quick pick menu for Token Sayar actions.
 * @param {object} ctx Context containing vscode, tracker, config/getConfig
 * @returns {Promise<void>}
 */
async function showQuickMenu(ctx) {
  const vs = (ctx && ctx.vscode) || getVscode();
  if (!vs || !vs.window || !vs.commands) {
    return;
  }
  const tracker = ctx && ctx.tracker;
  const config =
    (ctx && (typeof ctx.getConfig === 'function' ? ctx.getConfig() : ctx.config)) || {};
  const snap =
    ctx && ctx.snapshot !== undefined
      ? ctx.snapshot
      : tracker && typeof tracker.getSnapshot === 'function'
        ? tracker.getSnapshot()
        : null;
  const isEnabled = Boolean(config.enabled);

  let placeHolder = 'Takip duraklatıldı';
  if (isEnabled) {
    if (snap && snap.bloatLevel && snap.bloatLevel !== 'none') {
      const pct = Number.isFinite(Number(snap.percent)) ? `%${trDecimal(snap.percent, 1)}` : '';
      placeHolder = `${snap.title || 'Aktif sohbet'} — ${trTokens(snap.contextTokens)} / ${trTokens(
        snap.contextLimit || config.defaultContextLimit || 512000
      )} (${pct})`;
    } else {
      placeHolder = 'Aktif sohbet bekleniyor';
    }
  }

  const toggleItem = isEnabled
    ? {
        action: 'toggle',
        label: '$(debug-pause) Takibi Duraklat',
        description: 'Dosya izleyicileri ve zamanlayıcıları durdurur',
      }
    : {
        action: 'toggle',
        label: '$(play) Takibi Sürdür',
        description: 'Canlı token takibini başlatır',
      };

  const items = [
    toggleItem,
    {
      action: 'openPanel',
      label: '$(layout-sidebar-left) Token Sayar Görünümünü Aç',
      description: 'Bağlam durumu ve mesaj akışı',
    },
    {
      action: 'openTimeline',
      label: '$(list-ordered) Mesaj Akışını Aç',
      description: 'Mesajlar arası girdi, düşünme ve yanıt dağılımı',
    },
    {
      action: 'refresh',
      label: '$(refresh) Yenile',
      description: 'Güncel token verisini hemen oku',
    },
    {
      action: 'select',
      label: '$(arrow-swap) Sohbet Seç...',
      description:
        snap && snap.mode === 'pinned'
          ? 'Sabitli sohbeti değiştir veya aktif sohbete dön'
          : 'İncelenecek sohbeti seç',
    },
    {
      action: 'copy',
      label: '$(copy) Özeti Kopyala',
      description: 'Güncel bağlam ve oturum özetini panoya kopyalar',
    },
    {
      action: 'exportReport',
      label: '$(note) Raporu Aç',
      description: 'Sohbet bağlamı ve mesaj akışı raporunu Markdown olarak açar',
    },
    {
      action: 'settings',
      label: '$(gear) Ayarlar',
      description: 'Token Sayar eşik ve görünüm ayarları',
    },
    {
      action: 'help',
      label: '$(question) Yardım',
      description: 'Sayıların anlamı, eşikler ve araştırma kaynakları',
    },
  ];

  const picked = await vs.window.showQuickPick(items, {
    title: 'Token Sayar',
    placeHolder,
  });

  if (!picked) {
    return;
  }

  switch (picked.action) {
    case 'toggle':
      await vs.commands.executeCommand('tokenSayar.toggle');
      break;
    case 'openPanel':
      await vs.commands.executeCommand('tokenSayar.openPanel');
      break;
    case 'openTimeline':
      await vs.commands.executeCommand('tokenSayar.openTimeline');
      break;
    case 'refresh':
      await vs.commands.executeCommand('tokenSayar.refresh');
      break;
    case 'select':
      await vs.commands.executeCommand('tokenSayar.selectConversation');
      break;
    case 'copy': {
      const summary = buildClipboardSummary(
        tracker && typeof tracker.getSnapshot === 'function' ? tracker.getSnapshot() : snap,
        config
      );
      if (vs.env && vs.env.clipboard) {
        await vs.env.clipboard.writeText(summary);
      }
      if (vs.window && typeof vs.window.setStatusBarMessage === 'function') {
        vs.window.setStatusBarMessage('Token özeti panoya kopyalandı.', 3000);
      }
      break;
    }
    case 'exportReport':
      await vs.commands.executeCommand('tokenSayar.exportReport');
      break;
    case 'settings':
      await vs.commands.executeCommand('tokenSayar.openSettings');
      break;
    case 'help':
      await vs.commands.executeCommand('tokenSayar.showHelp');
      break;
    default:
      break;
  }
}

module.exports = {
  buildTooltip,
  buildClipboardSummary,
  renderStatusBar,
  maybeNotifyDanger,
  showQuickMenu,
};
