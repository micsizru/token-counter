'use strict';

/**
 * QuickPick conversation selector for Token Sayar views.
 *
 * Groups conversations by current vs. other workspaces, includes a follow-active option,
 * and updates inspected conversation state when a selection is made.
 *
 * Exports:
 * - showConversationPicker(ctx)
 */

const { trTokens, formatRelativeTime } = require('./format');

function buildConversationPickItem(conv) {
  const hasData =
    conv.hasTranscript &&
    conv.contextTokens != null &&
    conv.contextLimit != null &&
    conv.percent != null;
  const description = hasData
    ? `${trTokens(conv.contextTokens)} / ${trTokens(conv.contextLimit)} · %${Math.round(conv.percent)}`
    : 'Veri yok';
  const relTime = formatRelativeTime(conv.lastActivityMs || conv.lastModifiedMs);
  return {
    id: conv.id,
    label: conv.title || '(Başlıksız sohbet)',
    description,
    detail: `${conv.workspaceName || 'Çalışma alanı yok'} · ${relTime}`,
    isActiveAuto: Boolean(conv.isActiveAuto),
  };
}

async function showConversationPicker(ctx) {
  const vscode = ctx.vscode;
  const conversations = ctx.tracker
    ? ctx.tracker.listConversations(50, { includeTokens: true }) || []
    : [];

  const separatorKind =
    vscode.QuickPickItemKind && vscode.QuickPickItemKind.Separator !== undefined
      ? vscode.QuickPickItemKind.Separator
      : -1;

  const items = [
    {
      label: '$(target) Aktif sohbeti takip et',
      isFollowActive: true,
    },
  ];

  const currentWsItems = conversations
    .filter((c) => c.matchesWorkspace)
    .map(buildConversationPickItem);
  const otherWsItems = conversations
    .filter((c) => !c.matchesWorkspace)
    .map(buildConversationPickItem);

  if (currentWsItems.length > 0) {
    items.push({ label: 'Bu çalışma alanı', kind: separatorKind });
    items.push(...currentWsItems);
  }
  if (otherWsItems.length > 0) {
    items.push({ label: 'Diğer çalışma alanları', kind: separatorKind });
    items.push(...otherWsItems);
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Sohbet Seç',
    placeHolder: 'İncelenecek sohbeti seçin',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) {
    return undefined;
  }

  let nextId;
  if (picked.isFollowActive || picked.isActiveAuto) {
    nextId = null;
  } else if (picked.id) {
    nextId = picked.id;
  }

  if (nextId !== undefined && typeof ctx.setInspectedId === 'function') {
    ctx.setInspectedId(nextId);
  }
  if (typeof ctx.syncInspectingContext === 'function') {
    ctx.syncInspectingContext();
  }
  if (typeof ctx.refreshVisibleViews === 'function') {
    ctx.refreshVisibleViews();
  }

  return nextId;
}

module.exports = {
  showConversationPicker,
};
