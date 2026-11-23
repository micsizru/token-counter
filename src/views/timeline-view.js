'use strict';

/**
 * TreeView builder for the `tokenSayar.timeline` view.
 *
 * Handles lazy loading when visible, updates `_timelineView.description`, highlights the
 * highest-growth/highest-processed turn with a flame icon, and builds the 5 chronological
 * steps plus per-step progress children. Also provides shared turn-step metric normalization.
 *
 * Exports:
 * - normalizeTurnStepMetrics(turn)
 * - buildTimelineChildren(ctx, element)
 */

const {
  trTokens,
  truncateText,
  formatClockHM,
  makeMarkdownTooltip,
  makeTextTooltip,
  makeTreeItem,
} = require('./format');

function normalizeTurnStepMetrics(turn) {
  const t = turn || {};
  const stepCount = Number(t.stepCount) || 0;
  const freshInputTokens = Number(t.freshInputTokens) || 0;
  const cacheReadTokens = Number(t.cacheReadTokens) || 0;
  const totalReadTokens =
    t.totalReadTokens != null
      ? Number(t.totalReadTokens) || 0
      : freshInputTokens + cacheReadTokens;
  const avgReadPerStep = stepCount > 0 ? Math.round(totalReadTokens / stepCount) : 0;
  const thinkingTokens = Number(t.thinkingTokens) || 0;
  const visibleOutputTokens = Number(t.visibleOutputTokens) || 0;
  const totalProcessedTokens =
    Number(t.totalProcessedTokens) || totalReadTokens + thinkingTokens + visibleOutputTokens;
  const contextDelta = Number(t.contextDelta) || 0;
  const contextBefore = Number(t.contextBefore) || 0;
  const contextAfter = Number(t.contextAfter) || 0;
  const userPromptTokensEst = Number(t.userPromptTokensEst) || 0;

  const addedFromPrompt =
    t.addedContextFromPrompt != null
      ? Number(t.addedContextFromPrompt) || 0
      : contextDelta > 0
        ? Math.min(userPromptTokensEst, contextDelta)
        : userPromptTokensEst;
  const addedFromTools =
    t.addedContextFromToolsAndReplies != null
      ? Number(t.addedContextFromToolsAndReplies) || 0
      : contextDelta > 0
        ? Math.max(0, contextDelta - addedFromPrompt)
        : 0;

  return {
    stepCount,
    freshInputTokens,
    cacheReadTokens,
    totalReadTokens,
    avgReadPerStep,
    thinkingTokens,
    visibleOutputTokens,
    totalProcessedTokens,
    contextDelta,
    contextBefore,
    contextAfter,
    userPromptTokensEst,
    addedFromPrompt,
    addedFromTools,
  };
}

function findHighlightIndex(turns) {
  if (turns.length <= 1) {
    return -1;
  }
  let bestDelta = 0;
  let bestProcessed = 0;
  let bestDeltaIdx = -1;
  let bestProcessedIdx = -1;
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    if (t.isPreUser || (t.compactionCount || 0) > 0) {
      continue;
    }
    const delta = Number(t.contextDelta) || 0;
    const processed = Number(t.totalProcessedTokens) || 0;
    if (delta > bestDelta) {
      bestDelta = delta;
      bestDeltaIdx = i;
    }
    if (processed > bestProcessed) {
      bestProcessed = processed;
      bestProcessedIdx = i;
    }
  }
  return bestDeltaIdx >= 0 ? bestDeltaIdx : bestProcessedIdx;
}

function buildTimelineChildren(ctx, element) {
  const vscode = ctx.vscode;
  if (element) {
    return Array.isArray(element._children) ? element._children : [];
  }

  const timelineView = ctx.timelineView || null;
  const config = (typeof ctx.getConfig === 'function' ? ctx.getConfig() : {}) || {};
  if (config.enabled === false) {
    if (timelineView) {
      timelineView.description = undefined;
    }
    return [];
  }

  if (!timelineView || timelineView.visible !== true) {
    return [];
  }

  const snap = typeof ctx.getTargetSnapshot === 'function' ? ctx.getTargetSnapshot() : null;
  const targetId = snap && snap.conversationId ? snap.conversationId : null;
  if (!targetId || !ctx.tracker) {
    timelineView.description = undefined;
    return [];
  }

  const timeline = ctx.tracker.getMessageTimeline(targetId);
  const turns = timeline && Array.isArray(timeline.turns) ? timeline.turns : [];
  if (turns.length === 0) {
    timelineView.description = undefined;
    return [];
  }

  const totals = timeline.totals || {};
  timelineView.description = `${Number(totals.messageCount) || 0} mesaj, ${trTokens(totals.totalProcessedTokens)} token işlendi`;

  const hasThinkingSplit = Boolean(timeline.hasThinkingSplit);
  const highlightIdx = findHighlightIndex(turns);

  return turns.map((turn, idx) => {
    const isLast = idx === turns.length - 1;
    const cleanPrompt = String(turn.promptPreview || '').replace(/\s+/g, ' ').trim();
    const preview = truncateText(cleanPrompt, 48);
    const label = turn.isPreUser ? 'Başlangıç' : `${turn.index}. "${preview}"`;

    const metrics = normalizeTurnStepMetrics(turn);
    const hhmm = formatClockHM(turn.timestamp);
    const processedText = `${trTokens(turn.totalProcessedTokens)} işlendi`;
    const deltaBadge =
      metrics.contextDelta < 0
        ? 'Sıkıştırıldı'
        : metrics.contextDelta > 0
          ? `+${trTokens(metrics.contextDelta)}`
          : '';
    const descParts = [];
    if (hhmm) {
      descParts.push(hhmm);
    }
    descParts.push(processedText);
    if (deltaBadge) {
      descParts.push(deltaBadge);
    }
    const description = descParts.join(' · ');

    let iconPath;
    if (turn.compactionCount > 0) {
      iconPath = new vscode.ThemeIcon('fold');
    } else if (turn.isPreUser) {
      iconPath = new vscode.ThemeIcon('history');
    } else if (idx === highlightIdx) {
      iconPath = new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.orange'));
    } else {
      iconPath = new vscode.ThemeIcon('comment');
    }

    const tooltip = makeMarkdownTooltip(vscode, (md) => {
      if (!turn.isPreUser && cleanPrompt) {
        md.appendText(cleanPrompt);
        md.appendText('\n\n');
      }
      md.appendText(
        `Bu mesajla bir sonraki mesaj arasında toplam ${trTokens(turn.totalProcessedTokens)} token işlendi.`
      );
    });

    const step2Children = [
      makeTreeItem(vscode, {
        label: 'Önbellekten tekrar okunan',
        description: trTokens(metrics.cacheReadTokens),
        contextValue: 'metric',
        tooltip: makeTextTooltip(
          vscode,
          'Önceki konuşmanın her adımda önbellekten yeniden okunan kısmı. Hızlıdır ama kümülatif okuma toplamını büyütür.'
        ),
      }),
      makeTreeItem(vscode, {
        label: 'İlk kez okunan yeni girdi',
        description: trTokens(metrics.freshInputTokens),
        contextValue: 'metric',
        tooltip: makeTextTooltip(
          vscode,
          'Bu turda önbellek dışında ilk kez okunan dosyalar, araç çıktıları ve sistem talimatları.'
        ),
      }),
      makeTreeItem(vscode, {
        label: 'Adım başına ortalama okunan',
        description: metrics.stepCount > 0 ? trTokens(metrics.avgReadPerStep) : '—',
        contextValue: 'metric',
        tooltip: makeTextTooltip(
          vscode,
          'Bu turdaki her bir model adımında okunan ortalama bağlam boyutu.'
        ),
      }),
    ];

    const contextChangeDesc =
      metrics.contextDelta < 0
        ? `${trTokens(metrics.contextBefore)} → ${trTokens(metrics.contextAfter)} (Sıkıştırıldı −${trTokens(Math.abs(metrics.contextDelta))})`
        : `${trTokens(metrics.contextBefore)} → ${trTokens(metrics.contextAfter)} (+${trTokens(metrics.contextDelta)})`;

    const steps = Array.isArray(turn.steps) ? turn.steps : [];
    const stepProgressChildren = steps.map((s) =>
      makeTreeItem(vscode, {
        label: `Adım ${s.stepNumber}`,
        description: `${trTokens(s.contextTokens)} bağlam · ${hasThinkingSplit ? trTokens(s.thinkingTokens) : '—'} düşünme · ${trTokens(s.visibleOutputTokens)} yanıt · ${s.model || 'Bilinmiyor'}`,
        contextValue: 'metric',
        tooltip: makeTextTooltip(
          vscode,
          `Adım ${s.stepNumber} (${s.type || 'PLANNER_RESPONSE'}): ${trTokens(s.inputTokens)} yeni girdi, ${trTokens(s.cacheReadTokens)} önbellek okuma, toplam ${trTokens(s.contextTokens)} aktif bağlam.`
        ),
      })
    );

    const step5Children = [
      makeTreeItem(vscode, {
        label: 'Önceki bağlam',
        description: trTokens(metrics.contextBefore),
        contextValue: 'metric',
        tooltip: makeTextTooltip(vscode, 'Bu tur başlamadan önceki aktif bağlam boyutu.'),
      }),
    ];

    if (metrics.contextDelta >= 0) {
      step5Children.push(
        makeTreeItem(vscode, {
          label: 'Eklenen kullanıcı mesajı',
          description: metrics.addedFromPrompt > 0 ? `+~${trTokens(metrics.addedFromPrompt)}` : '0',
          contextValue: 'metric',
          tooltip: makeTextTooltip(
            vscode,
            'Kullanıcı mesajının kalıcı bağlama eklenen tahmini payı.'
          ),
        }),
        makeTreeItem(vscode, {
          label: 'Eklenen araç çıktıları ve yanıtlar',
          description: `+${trTokens(metrics.addedFromTools)}`,
          contextValue: 'metric',
          tooltip: makeTextTooltip(
            vscode,
            'Araç çıktıları ve model yanıtlarından kalıcı bağlama eklenen net miktar.'
          ),
        })
      );
    } else {
      step5Children.push(
        makeTreeItem(vscode, {
          label: 'Sıkıştırma ile temizlenen',
          description: `−${trTokens(Math.abs(metrics.contextDelta))}`,
          contextValue: 'metric',
          tooltip: makeTextTooltip(
            vscode,
            'Otomatik sıkıştırma (özetleme) sırasında bağlamdan düşülen token miktarı.'
          ),
        })
      );
    }

    const newContextTooltip =
      metrics.contextDelta >= 0
        ? `${trTokens(metrics.contextBefore)} + ${trTokens(metrics.addedFromPrompt)} + ${trTokens(metrics.addedFromTools)} = ${trTokens(metrics.contextAfter)}`
        : `${trTokens(metrics.contextBefore)} − ${trTokens(Math.abs(metrics.contextDelta))} = ${trTokens(metrics.contextAfter)}`;

    step5Children.push(
      makeTreeItem(vscode, {
        label: 'Yeni aktif bağlam',
        description: trTokens(metrics.contextAfter),
        contextValue: 'metric',
        tooltip: makeTextTooltip(vscode, newContextTooltip),
      }),
      makeTreeItem(vscode, {
        label: `Adım adım bağlam ilerlemesi (${steps.length} adım)`,
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        contextValue: 'metric',
        tooltip: makeTextTooltip(
          vscode,
          'Bu tur içindeki her model adımında aktif bağlamın nasıl ilerlediğini gösterir.'
        ),
        _children: stepProgressChildren,
      })
    );

    const children = [
      makeTreeItem(vscode, {
        label: '1. Senin mesajın',
        description:
          metrics.userPromptTokensEst > 0 ? `~${trTokens(metrics.userPromptTokensEst)}` : '0',
        iconPath: new vscode.ThemeIcon('account'),
        contextValue: 'metric',
        tooltip: makeTextTooltip(
          vscode,
          'Yazdığın metnin tahmini token sayısı (yaklaşık 4 karakter = 1 token).'
        ),
      }),
      makeTreeItem(vscode, {
        label: `2. Modele okutulan bağlam (${metrics.stepCount} adım)`,
        description: `${trTokens(metrics.totalReadTokens)} (${trTokens(metrics.cacheReadTokens)} önbellek · ${trTokens(metrics.freshInputTokens)} yeni)`,
        iconPath: new vscode.ThemeIcon('database'),
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        contextValue: 'metric',
        tooltip: makeTextTooltip(
          vscode,
          'Bu turdaki tüm model adımlarında modele okutulan kümülatif girdi trafiğidir. Her adımda önceki bağlam yeniden okunduğu için toplam büyük görünür; bu sayı kalıcı bağlam büyümesi değildir.'
        ),
        _children: step2Children,
      }),
      makeTreeItem(vscode, {
        label: '3. Model düşünmesi (geçici)',
        description: hasThinkingSplit ? trTokens(turn.thinkingTokens) : '—',
        iconPath: new vscode.ThemeIcon('lightbulb'),
        contextValue: 'metric',
        tooltip: makeTextTooltip(
          vscode,
          hasThinkingSplit
            ? 'Modelin yanıt vermeden önce ürettiği geçici akıl yürütme tokenlarıdır. Sonraki turların kalıcı bağlamını şişirmez.'
            : 'Bu sohbet veya model düşünme miktarını ayrı bildirmiyor; geçici düşünme sonraki turların kalıcı bağlamını şişirmez.'
        ),
      }),
      makeTreeItem(vscode, {
        label: '4. Model yanıtı ve araç çağrıları',
        description: trTokens(turn.visibleOutputTokens),
        iconPath: new vscode.ThemeIcon('symbol-method'),
        contextValue: 'metric',
        tooltip: makeTextTooltip(
          vscode,
          `Sana yazılan metin ile dosya okuma ve komut çalıştırma gibi araç çağrıları. Turda toplam işlenen: ${trTokens(metrics.totalReadTokens)} okunan + ${hasThinkingSplit ? trTokens(metrics.thinkingTokens) : '0'} düşünme + ${trTokens(metrics.visibleOutputTokens)} yanıt = ${trTokens(metrics.totalProcessedTokens)} token.`
        ),
      }),
      makeTreeItem(vscode, {
        label: '5. Net bağlam değişimi (kalıcı)',
        description: contextChangeDesc,
        iconPath: new vscode.ThemeIcon('diff'),
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        contextValue: 'metric',
        tooltip: makeTextTooltip(
          vscode,
          'Bu mesaj turunun aktif bağlam penceresinde bıraktığı kalıcı net değişim.'
        ),
        _children: step5Children,
      }),
    ];

    return makeTreeItem(vscode, {
      label,
      description,
      collapsibleState: isLast
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
      iconPath,
      tooltip,
      _children: children,
    });
  });
}

module.exports = {
  normalizeTurnStepMetrics,
  buildTimelineChildren,
};
