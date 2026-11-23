'use strict';

/**
 * TreeView builder for the `tokenSayar.context` view.
 *
 * Renders the root context metrics (`Sohbet`, `Aktif sohbete dön`, `Doluluk`, `Durum`,
 * `Kalan`, `Model`, `Tur ve sıkıştırma`, `Ayrıntılar`), nested model/detail items, and
 * updates `_contextView` metadata (`description`, `message`, `badge`).
 *
 * Exports:
 * - buildContextChildren(ctx, element)
 * - buildDetailChildren(vscode, snap, totalProcessedSession, cacheSavingsPct)
 */

const {
  LIMIT_SOURCE_LABELS,
  getTierInfo,
  trTokens,
  trDecimal,
  trRawInt,
  truncateText,
  formatClockHMS,
  buildThresholdBar,
  makeMarkdownTooltip,
  makeTextTooltip,
  makeTreeItem,
} = require('./format');

function clearContextViewMeta(contextView) {
  if (!contextView) {
    return;
  }
  contextView.description = undefined;
  contextView.message = undefined;
  contextView.badge = undefined;
}

function buildDetailChildren(vscode, snap, totalProcessedSession, cacheSavingsPct) {
  const limitSourceLabel =
    LIMIT_SOURCE_LABELS[snap.contextLimitSource] || LIMIT_SOURCE_LABELS.default;

  return [
    makeTreeItem(vscode, {
      label: 'Son adım yeni girdi',
      description: trTokens(snap.lastInputTokens),
      contextValue: 'metric',
      tooltip: makeTextTooltip(
        vscode,
        'Son model adımında önbellek dışında ilk kez okunan token miktarı.'
      ),
    }),
    makeTreeItem(vscode, {
      label: 'Son adım önbellekten okunan',
      description: trTokens(snap.lastCacheReadTokens),
      contextValue: 'metric',
      tooltip: makeTextTooltip(
        vscode,
        'Son model adımında önbellekten tekrar okunan token miktarı.'
      ),
    }),
    makeTreeItem(vscode, {
      label: 'Son adım çıktısı',
      description: trTokens(snap.lastOutputTokens),
      contextValue: 'metric',
      tooltip: makeTextTooltip(
        vscode,
        'Son model adımında üretilen toplam çıktı token miktarı.'
      ),
    }),
    makeTreeItem(vscode, {
      label: 'Oturum toplamı işlenen',
      description: trTokens(totalProcessedSession),
      contextValue: 'metric',
      tooltip: makeTextTooltip(
        vscode,
        'Oturum boyunca tüm adımlarda işlenen toplam girdi ve önbellek token miktarı.'
      ),
    }),
    makeTreeItem(vscode, {
      label: 'Oturum toplam çıktı',
      description: trTokens(snap.totalOutputTokens),
      contextValue: 'metric',
      tooltip: makeTextTooltip(
        vscode,
        'Oturum boyunca modelin ürettiği toplam çıktı token miktarı.'
      ),
    }),
    makeTreeItem(vscode, {
      label: 'Önbellek tasarruf oranı',
      description: `%${trDecimal(cacheSavingsPct, 1)}`,
      contextValue: 'metric',
      tooltip: makeTextTooltip(
        vscode,
        'Oturum boyunca okunan toplam girdi tokenlarının ne kadarının önbellekten karşılandığını gösterir.'
      ),
    }),
    makeTreeItem(vscode, {
      label: 'Limit kaynağı',
      description: limitSourceLabel,
      contextValue: 'metric',
      tooltip: makeTextTooltip(
        vscode,
        'Aktif bağlam limitinin hangi kaynaktan belirlendiğini gösterir.'
      ),
    }),
    makeTreeItem(vscode, {
      label: 'Son güncelleme',
      description: formatClockHMS(snap.lastUpdatedAt),
      contextValue: 'metric',
      tooltip: makeTextTooltip(vscode, 'Son token verisinin okunduğu saat.'),
    }),
  ];
}

function buildContextChildren(ctx, element) {
  const vscode = ctx.vscode;
  if (element) {
    return Array.isArray(element._children) ? element._children : [];
  }

  const config = (typeof ctx.getConfig === 'function' ? ctx.getConfig() : {}) || {};
  const contextView = ctx.contextView || null;

  if (config.enabled === false) {
    clearContextViewMeta(contextView);
    return [];
  }

  const snap = typeof ctx.getTargetSnapshot === 'function' ? ctx.getTargetSnapshot() : null;
  if (!snap || !snap.conversationId) {
    clearContextViewMeta(contextView);
    return [
      makeTreeItem(vscode, {
        label: 'Aktif sohbet bulunamadı',
        contextValue: 'metric',
        collapsibleState: vscode.TreeItemCollapsibleState.None,
      }),
    ];
  }

  const inspectedId =
    typeof ctx.getInspectedId === 'function' ? ctx.getInspectedId() : ctx.inspectedId;

  const rawTitle = snap.title || `Sohbet ${String(snap.conversationId).slice(0, 8)}`;
  const shortTitle = truncateText(rawTitle, 40) || rawTitle;
  const hasTranscript = Boolean(snap.hasTranscript);
  const contextTokens = Number(snap.contextTokens) || 0;
  const contextLimit = Number(snap.contextLimit) || Number(config.defaultContextLimit) || 512000;
  const percent = Number.isFinite(Number(snap.percent)) ? Number(snap.percent) : 0;
  const warnPercent = config.warnPercent != null ? Number(config.warnPercent) : 55;
  const dangerPercent = config.dangerPercent != null ? Number(config.dangerPercent) : 80;
  const bloatLevel = hasTranscript ? snap.bloatLevel : 'none';

  const tierInfo = getTierInfo(hasTranscript ? percent : null, bloatLevel, config);

  if (contextView) {
    contextView.description = shortTitle || undefined;
    contextView.message = inspectedId
      ? 'Aktif olmayan bir sohbet gösteriliyor.'
      : undefined;
    if (hasTranscript && snap.bloatLevel !== 'none' && snap.percent != null && percent >= warnPercent) {
      const rounded = Math.round(percent);
      contextView.badge = {
        value: rounded,
        tooltip: `Bağlam %${rounded} dolu`,
      };
    } else {
      contextView.badge = undefined;
    }
  }

  const sohbetItem = makeTreeItem(vscode, {
    label: 'Sohbet',
    description: `${shortTitle}${inspectedId ? ' (İnceleniyor)' : ''} · Değiştir`,
    iconPath: new vscode.ThemeIcon('comment-discussion'),
    command: {
      command: 'tokenSayar.selectConversation',
      title: 'Sohbet Seç...',
    },
    contextValue: 'action',
    tooltip: makeTextTooltip(vscode, 'İncelenecek sohbeti seçmek için tıklayın.'),
  });

  const followActiveItem = inspectedId
    ? makeTreeItem(vscode, {
        label: 'Aktif sohbete dön',
        description: 'Canlı takibe geç',
        iconPath: new vscode.ThemeIcon('target'),
        command: {
          command: 'tokenSayar.followActive',
          title: 'Aktif Sohbete Dön',
        },
        contextValue: 'action',
        tooltip: makeTextTooltip(vscode, 'Etkin sohbetin canlı takibine geri döner.'),
      })
    : null;

  const warnTokensText = trTokens((contextLimit * warnPercent) / 100);
  const dangerTokensText = trTokens((contextLimit * dangerPercent) / 100);
  const dolulukDesc = hasTranscript
    ? `${buildThresholdBar(percent, warnPercent, dangerPercent)}  ${trTokens(contextTokens)} / ${trTokens(contextLimit)} (%${trDecimal(percent, 1)})`
    : 'Veri yok';

  const dolulukItem = makeTreeItem(vscode, {
    label: 'Doluluk',
    description: dolulukDesc,
    contextValue: 'metric',
    iconPath: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(tierInfo.color)),
    tooltip: makeTextTooltip(
      vscode,
      `Modelin şu anda hafızasında tuttuğu bağlam miktarı (${trRawInt(contextTokens)} / ${trRawInt(contextLimit)} token). Sarı eşik: %${warnPercent} (${warnTokensText}), kırmızı eşik: %${dangerPercent} (${dangerTokensText}).`
    ),
  });

  const durumItem = makeTreeItem(vscode, {
    label: 'Durum',
    description: tierInfo.label,
    iconPath:
      bloatLevel === 'warn' || bloatLevel === 'danger'
        ? new vscode.ThemeIcon('warning', new vscode.ThemeColor(tierInfo.color))
        : new vscode.ThemeIcon('pulse', new vscode.ThemeColor(tierInfo.color)),
    contextValue: 'metric',
    tooltip: makeTextTooltip(vscode, tierInfo.advice),
  });

  const remainingTokens = Math.max(0, contextLimit - contextTokens);
  const kalanDesc = hasTranscript
    ? snap.estimatedRemainingMessages != null
      ? `${trTokens(remainingTokens)} (~${snap.estimatedRemainingMessages} mesaj)`
      : trTokens(remainingTokens)
    : '—';
  const kalanTooltip =
    hasTranscript && snap.estimatedRemainingMessages != null && snap.avgContextGrowthPerMessage > 0
      ? `Otomatik sıkıştırmaya kadar kalan alan (${trRawInt(remainingTokens)} token). Son mesajlardaki ortalama bağlam büyümesi (~${trTokens(snap.avgContextGrowthPerMessage)}/mesaj) temel alınarak yaklaşık ${snap.estimatedRemainingMessages} mesaj daha sığabileceği tahmin edilmektedir.`
      : 'Otomatik sıkıştırmaya kadar kalan alan. Yeterli mesaj geçmişi oluştuğunda tahmini kalan mesaj sayısı da gösterilir.';

  const kalanItem = makeTreeItem(vscode, {
    label: 'Kalan',
    description: kalanDesc,
    contextValue: 'metric',
    tooltip: makeTextTooltip(vscode, kalanTooltip),
  });

  const modelsUsed = Array.isArray(snap.modelsUsed) ? snap.modelsUsed : [];
  const latestModel = snap.modelDisplayName || snap.model || 'Bilinmiyor';
  const hasMultiModels = modelsUsed.length > 1;
  const modelChildren = hasMultiModels
    ? modelsUsed.map((m) =>
        makeTreeItem(vscode, {
          label: m,
          contextValue: 'metric',
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          tooltip: makeMarkdownTooltip(vscode, (md) => {
            md.appendText(`Bu sohbette kullanılan model: ${m}`);
          }),
        })
      )
    : [];

  const modelItem = makeTreeItem(vscode, {
    label: 'Model',
    description: hasMultiModels
      ? `${modelsUsed.length} model, son: ${latestModel}`
      : latestModel,
    contextValue: 'metric',
    collapsibleState: hasMultiModels
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
    tooltip: makeTextTooltip(
      vscode,
      'Limit her zaman son kullanılan modelin bütçesine göre hesaplanır.'
    ),
    _children: modelChildren,
  });

  const turSikistirmaItem = makeTreeItem(vscode, {
    label: 'Tur ve sıkıştırma',
    description: `${Number(snap.turnCount) || 0} tur · ${Number(snap.compactionCount) || 0} sıkıştırma`,
    contextValue: 'metric',
    tooltip: makeTextTooltip(
      vscode,
      'Modelin yanıt verdiği adım sayısı (araç çağrıları dahil) ve sohbetin kaç kez otomatik özetlendiği (sıkıştırıldığı).'
    ),
  });

  const totalCacheReadSession = Number(snap.totalCacheReadTokens) || 0;
  const totalProcessedSession = (Number(snap.totalInputTokens) || 0) + totalCacheReadSession;
  const cacheSavingsPct =
    totalProcessedSession > 0 ? (totalCacheReadSession / totalProcessedSession) * 100 : 0;

  const detailChildren = buildDetailChildren(
    vscode,
    snap,
    totalProcessedSession,
    cacheSavingsPct
  );

  const ayrintilarItem = makeTreeItem(vscode, {
    label: 'Ayrıntılar',
    contextValue: 'metric',
    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    iconPath: new vscode.ThemeIcon('list-unordered'),
    tooltip: makeTextTooltip(vscode, 'Son adım, oturum toplamları ve limit kaynağı ayrıntıları.'),
    _children: detailChildren,
  });

  const rootItems = [sohbetItem];
  if (followActiveItem) {
    rootItems.push(followActiveItem);
  }
  rootItems.push(
    dolulukItem,
    durumItem,
    kalanItem,
    modelItem,
    turSikistirmaItem,
    ayrintilarItem
  );
  return rootItems;
}

module.exports = {
  buildContextChildren,
  buildDetailChildren,
};
