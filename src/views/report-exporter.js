'use strict';

/**
 * Markdown report builder and exporter for Token Sayar conversations.
 *
 * Formats a full Markdown report containing context summary, threshold table, and
 * chronological 1->5 step breakdown per turn, and opens it as an untitled Markdown
 * document in VS Code.
 *
 * Exports:
 * - buildMarkdownReport(snapshot, timeline, config, options)
 * - exportConversationReport(ctx)
 */

const {
  getTierInfo,
  trTokens,
  trDecimal,
  trRawInt,
  truncateText,
  formatClockHMS,
  formatClockHM,
} = require('./format');
const { normalizeTurnStepMetrics } = require('./timeline-view');

function buildMarkdownReport(snapshot, timeline, config = {}, options = {}) {
  const snap = snapshot || {};
  const cfg = config || {};
  const tl = timeline || { turns: [], totals: {}, hasThinkingSplit: false };

  const rawTitle = snap.title || `Sohbet ${String(snap.conversationId).slice(0, 8)}`;
  const hasTranscript = Boolean(snap.hasTranscript);
  const contextTokens = Number(snap.contextTokens) || 0;
  const contextLimit = Number(snap.contextLimit) || Number(cfg.defaultContextLimit) || 512000;
  const percent = Number.isFinite(Number(snap.percent)) ? Number(snap.percent) : 0;
  const warnPercent = cfg.warnPercent != null ? Number(cfg.warnPercent) : 55;
  const dangerPercent = cfg.dangerPercent != null ? Number(cfg.dangerPercent) : 80;
  const bloatLevel = hasTranscript ? snap.bloatLevel : 'none';
  const tierInfo = getTierInfo(hasTranscript ? percent : null, bloatLevel, cfg);

  const remainingTokens = Math.max(0, contextLimit - contextTokens);
  const totalCacheReadSession = Number(snap.totalCacheReadTokens) || 0;
  const totalInputSession = Number(snap.totalInputTokens) || 0;
  const totalProcessedSession = totalInputSession + totalCacheReadSession;
  const cacheSavingsPct =
    totalProcessedSession > 0 ? (totalCacheReadSession / totalProcessedSession) * 100 : 0;
  const modeLabel = options.isInspected
    ? 'İncelenen sohbet'
    : snap.mode === 'pinned'
      ? 'Sabitli'
      : 'Otomatik';

  const lines = [
    `# Token Sayar Raporu: ${rawTitle}`,
    '',
    `- Sohbet ID: \`${snap.conversationId}\``,
    `- İzleme modu: ${modeLabel}`,
    `- Model: ${snap.modelDisplayName || snap.model || 'Bilinmiyor'}`,
    `- Son güncelleme: ${formatClockHMS(snap.lastUpdatedAt)}`,
    '',
    '## Bağlam Özeti',
    '',
    '| Metrik | Değer |',
    '| --- | --- |',
    `| Doluluk | ${hasTranscript ? `${trTokens(contextTokens)} / ${trTokens(contextLimit)} (%${trDecimal(percent, 1)}) (${trRawInt(contextTokens)} / ${trRawInt(contextLimit)} token)` : 'Veri yok'} |`,
    `| Durum | ${tierInfo.label} (${tierInfo.advice}) |`,
    `| Kalan alan | ${hasTranscript ? (snap.estimatedRemainingMessages != null ? `${trTokens(remainingTokens)} (~${snap.estimatedRemainingMessages} mesaj)` : trTokens(remainingTokens)) : '—'} |`,
    `| Tur ve sıkıştırma | ${Number(snap.turnCount) || 0} tur · ${Number(snap.compactionCount) || 0} sıkıştırma |`,
    `| Oturum toplamı işlenen | ${trTokens(totalProcessedSession)} (${trTokens(totalCacheReadSession)} önbellek · ${trTokens(totalInputSession)} yeni · %${trDecimal(cacheSavingsPct, 1)} önbellek tasarrufu) |`,
    `| Oturum toplam çıktı | ${trTokens(snap.totalOutputTokens)} |`,
    '',
    '## Eşik Tablosu',
    '',
    '| Eşik | Yüzde | Token Karşılığı |',
    '| --- | --- | --- |',
    `| Sarı uyarı eşiği | %${warnPercent} | ${trTokens((contextLimit * warnPercent) / 100)} |`,
    `| Kırmızı kritik eşik | %${dangerPercent} | ${trTokens((contextLimit * dangerPercent) / 100)} |`,
    `| Otomatik sıkıştırma limiti | %100 | ${trTokens(contextLimit)} |`,
    '',
    '## Mesaj Akışı (1 -> 5 Adım Dağılımı)',
    '',
  ];

  const turns = Array.isArray(tl.turns) ? tl.turns : [];
  const totals = tl.totals || {};
  const hasThinkingSplit = Boolean(tl.hasThinkingSplit);

  if (turns.length === 0) {
    lines.push('Bu sohbet için henüz mesaj akışı verisi bulunmuyor.');
  } else {
    lines.push(
      `Toplam ${Number(totals.messageCount) || 0} kullanıcı mesajı, ${trTokens(totals.totalProcessedTokens)} token işlendi.`
    );
    lines.push('');

    for (const turn of turns) {
      const cleanPrompt = String(turn.promptPreview || '').replace(/\s+/g, ' ').trim();
      const heading = turn.isPreUser
        ? 'Başlangıç'
        : `${turn.index}. "${truncateText(cleanPrompt, 80)}"`;
      const hhmm = formatClockHM(turn.timestamp);
      lines.push(`### ${heading}${hhmm ? ` (${hhmm})` : ''}`);
      lines.push('');

      const metrics = normalizeTurnStepMetrics(turn);
      const changeSummary =
        metrics.contextDelta < 0
          ? `${trTokens(metrics.contextBefore)} → ${trTokens(metrics.contextAfter)} (Sıkıştırıldı −${trTokens(Math.abs(metrics.contextDelta))})`
          : `${trTokens(metrics.contextBefore)} → ${trTokens(metrics.contextAfter)} (+${trTokens(metrics.contextDelta)}; ${trTokens(metrics.contextBefore)} + ${trTokens(metrics.addedFromPrompt)} + ${trTokens(metrics.addedFromTools)} = ${trTokens(metrics.contextAfter)})`;

      lines.push(
        `1. Senin mesajın: ${metrics.userPromptTokensEst > 0 ? `~${trTokens(metrics.userPromptTokensEst)}` : '0'}`
      );
      lines.push(
        `2. Modele okutulan bağlam (${metrics.stepCount} adım): ${trTokens(metrics.totalReadTokens)} (${trTokens(metrics.cacheReadTokens)} önbellek · ${trTokens(metrics.freshInputTokens)} yeni)`
      );
      lines.push(
        `3. Model düşünmesi (geçici): ${hasThinkingSplit ? trTokens(turn.thinkingTokens) : '—'}`
      );
      lines.push(
        `4. Model yanıtı ve araç çağrıları: ${trTokens(turn.visibleOutputTokens)} (Tur toplamı: ${trTokens(metrics.totalProcessedTokens)})`
      );
      lines.push(`5. Net bağlam değişimi (kalıcı): ${changeSummary}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function exportConversationReport(ctx) {
  const vscode = ctx.vscode;
  const snap = typeof ctx.getTargetSnapshot === 'function' ? ctx.getTargetSnapshot() : null;
  if (!snap || !snap.conversationId) {
    if (vscode.window && typeof vscode.window.showInformationMessage === 'function') {
      await vscode.window.showInformationMessage(
        'Token Sayar: Rapor oluşturmak için aktif bir sohbet bulunamadı.'
      );
    }
    return;
  }

  const config = (typeof ctx.getConfig === 'function' ? ctx.getConfig() : {}) || {};
  const timeline = ctx.tracker
    ? ctx.tracker.getMessageTimeline(snap.conversationId)
    : { turns: [], totals: {}, hasThinkingSplit: false };
  const inspectedId =
    typeof ctx.getInspectedId === 'function' ? ctx.getInspectedId() : ctx.inspectedId;

  const content = buildMarkdownReport(snap, timeline, config, {
    isInspected: Boolean(inspectedId),
  });
  const doc = await vscode.workspace.openTextDocument({
    content,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc);
}

module.exports = {
  buildMarkdownReport,
  exportConversationReport,
};
