'use strict';

/**
 * Per-message timeline builder combining `transcript.jsonl` turns with conversation SQLite
 * `gen_metadata` thinking vs. visible output splits.
 *
 * Exports:
 * - `buildMessageTimeline`
 */

const fs = require('fs');
const path = require('path');
const { getTranscriptPath } = require('./transcript');
const { getSqliteStatKey, querySqliteOneShot } = require('./sqlite');
const { parseGenMetadataUsage, parseGenModelDisplayName } = require('../proto');

/**
 * Build a chronological, message-by-message token timeline for a conversation,
 * grouping turns by real `USER_INPUT` prompts and enriching `PLANNER_RESPONSE` steps
 * with `gen_metadata` thinking vs visible output token splits.
 *
 * Cached by `(transcriptSize, transcriptMtimeMs, dbStatKey)` for ~0ms repeat reads.
 *
 * @param {object} tracker
 * @param {string} conversationId
 */
function buildMessageTimeline(tracker, conversationId) {
  const id = typeof conversationId === 'string' ? conversationId.trim() : '';
  const emptyTotals = {
    messageCount: 0,
    userPromptTokensEst: 0,
    thinkingTokens: 0,
    visibleOutputTokens: 0,
    outputTokens: 0,
    freshInputTokens: 0,
    cacheReadTokens: 0,
    totalProcessedTokens: 0,
  };

  if (!id) {
    return {
      conversationId: '',
      title: '',
      hasThinkingSplit: false,
      totals: emptyTotals,
      turns: [],
    };
  }

  const { byId } = tracker._loadSummariesWithAnnotations();
  const summary = byId.get(id) || null;
  const title = (summary && summary.title) || '';

  const transcriptPath = getTranscriptPath(tracker.antigravityDir, id);
  let trStat = null;
  try {
    trStat = fs.statSync(transcriptPath);
  } catch {
    tracker._timelineCache.delete(id);
    return {
      conversationId: id,
      title,
      hasThinkingSplit: false,
      totals: emptyTotals,
      turns: [],
    };
  }

  const convDbPath = path.join(tracker.antigravityDir, 'conversations', `${id}.db`);
  const dbStat = getSqliteStatKey(convDbPath);
  const cacheKey = `${trStat.size}:${trStat.mtimeMs}|${dbStat ? dbStat.key : ''}`;
  const cached = tracker._timelineCache.get(id);
  if (cached && cached.key === cacheKey) {
    return {
      ...cached.timeline,
      title: title || cached.timeline.title,
    };
  }

  const gmEntries =
    querySqliteOneShot(convDbPath, (db) => {
      const list = [];
      try {
        const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
        for (const row of rows) {
          if (!row || !row.data) {
            continue;
          }
          const buf = Buffer.from(row.data);
          list.push({
            usage: parseGenMetadataUsage(buf),
            displayName: parseGenModelDisplayName(buf),
          });
        }
      } catch {
        // Table may not exist in legacy/empty DBs
      }
      return list;
    }) || [];

  let rawText = '';
  try {
    rawText = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return {
      conversationId: id,
      title,
      hasThinkingSplit: false,
      totals: emptyTotals,
      turns: [],
    };
  }

  const lines = rawText.split('\n');
  const turns = [];
  let currentTurn = null;
  let nextUserIndex = 1;
  let plannerOrdinal = 0;
  let lastContext = 0;
  let hasThinkingSplit = false;

  const createTurn = (index, isPreUser, timestamp, cleanPrompt) => {
    const promptCharCount = cleanPrompt.length;
    const promptPreview =
      promptCharCount > 140 ? cleanPrompt.slice(0, 137) + '...' : cleanPrompt;
    const userPromptTokensEst = cleanPrompt
      ? Math.max(1, Math.ceil(promptCharCount / 4))
      : 0;

    return {
      index,
      isPreUser,
      timestamp: timestamp || null,
      promptPreview,
      promptCharCount,
      userPromptTokensEst,
      stepCount: 0,
      compactionCount: 0,
      models: [],
      freshInputTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      visibleOutputTokens: 0,
      outputTokens: 0,
      totalReadTokens: 0,
      totalProcessedTokens: 0,
      contextBefore: lastContext,
      contextAfter: lastContext,
      contextDelta: 0,
      addedContextFromPrompt: 0,
      addedContextFromToolsAndReplies: 0,
      steps: [],
      _hasTokenStep: false,
    };
  };

  const finalizeTurn = (turn) => {
    if (!turn) {
      return;
    }
    if (!turn._hasTokenStep) {
      turn.contextAfter = turn.contextBefore;
    }
    turn.contextDelta = turn.contextAfter - turn.contextBefore;
    turn.totalReadTokens = turn.freshInputTokens + turn.cacheReadTokens;
    turn.totalProcessedTokens =
      turn.freshInputTokens + turn.cacheReadTokens + turn.outputTokens;
    turn.addedContextFromPrompt =
      turn.contextDelta > 0
        ? Math.min(turn.userPromptTokensEst, turn.contextDelta)
        : turn.userPromptTokensEst;
    turn.addedContextFromToolsAndReplies =
      turn.contextDelta > 0
        ? Math.max(0, turn.contextDelta - Math.min(turn.userPromptTokensEst, turn.contextDelta))
        : 0;
    lastContext = turn.contextAfter;
    delete turn._hasTokenStep;
    turns.push(turn);
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || !trimmed.startsWith('{')) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') {
      continue;
    }

    const ts =
      typeof obj.created_at === 'string' && obj.created_at.trim()
        ? obj.created_at.trim()
        : typeof obj.timestamp === 'string' && obj.timestamp.trim()
          ? obj.timestamp.trim()
          : null;

    if (obj.type === 'USER_INPUT') {
      finalizeTurn(currentTurn);
      const rawContent = typeof obj.content === 'string' ? obj.content : '';
      const cleanText = rawContent
        .replace(/^\s*<USER_REQUEST>\s*/i, '')
        .replace(/\s*<\/USER_REQUEST>\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      currentTurn = createTurn(nextUserIndex++, false, ts, cleanText);
      continue;
    }

    if (obj.type === 'CHECKPOINT') {
      if (!currentTurn) {
        currentTurn = createTurn(0, true, ts, '');
      }
      currentTurn.compactionCount += 1;
      currentTurn.steps.push({
        stepNumber: currentTurn.steps.length + 1,
        type: 'CHECKPOINT',
        model: null,
        inputTokens: Number(obj.input_tokens) || 0,
        cacheReadTokens: Number(obj.cache_read_tokens) || 0,
        contextTokens:
          typeof obj.input_tokens === 'number' && Number.isFinite(obj.input_tokens)
            ? obj.input_tokens + (Number(obj.cache_read_tokens) || 0)
            : (currentTurn._hasTokenStep ? currentTurn.contextAfter : currentTurn.contextBefore),
        thinkingTokens: 0,
        visibleOutputTokens: 0,
        outputTokens: Number(obj.output_tokens) || 0,
      });
      continue;
    }

    if (obj.type === 'PLANNER_RESPONSE') {
      const gmEntry = plannerOrdinal < gmEntries.length ? gmEntries[plannerOrdinal] : null;
      plannerOrdinal += 1;

      if (!currentTurn) {
        currentTurn = createTurn(0, true, ts, '');
      }
      if (!currentTurn.timestamp && ts) {
        currentTurn.timestamp = ts;
      }

      currentTurn.stepCount += 1;

      const modelName =
        (gmEntry && gmEntry.displayName) ||
        (typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : null);
      if (modelName && !currentTurn.models.includes(modelName)) {
        currentTurn.models.push(modelName);
      }

      const hasNumericInput =
        typeof obj.input_tokens === 'number' && Number.isFinite(obj.input_tokens);
      let inputTokensOrZero = 0;
      let cacheReadTokensOrZero = 0;
      let thinkingTokensOrZero = 0;
      let visibleOutputTokensOrZero = 0;
      let outputTokensOrZero = 0;
      let stepContextTokens = currentTurn._hasTokenStep
        ? currentTurn.contextAfter
        : currentTurn.contextBefore;

      if (hasNumericInput) {
        const inputTokens = obj.input_tokens;
        const cacheReadTokens =
          typeof obj.cache_read_tokens === 'number' && Number.isFinite(obj.cache_read_tokens)
            ? obj.cache_read_tokens
            : 0;
        const outputTokens =
          typeof obj.output_tokens === 'number' && Number.isFinite(obj.output_tokens)
            ? obj.output_tokens
            : 0;

        let thinkingTokens = 0;
        let visibleOutputTokens = outputTokens;

        const gmUsage = gmEntry && gmEntry.usage;
        if (
          gmUsage &&
          gmUsage.inputTokens === inputTokens &&
          gmUsage.cacheReadTokens === cacheReadTokens &&
          gmUsage.outputTokens === outputTokens
        ) {
          if (gmUsage.hasThinkingField) {
            hasThinkingSplit = true;
          }
          thinkingTokens = gmUsage.thinkingTokens;
          visibleOutputTokens = gmUsage.visibleOutputTokens;
        }

        inputTokensOrZero = inputTokens;
        cacheReadTokensOrZero = cacheReadTokens;
        thinkingTokensOrZero = thinkingTokens;
        visibleOutputTokensOrZero = visibleOutputTokens;
        outputTokensOrZero = outputTokens;
        stepContextTokens = inputTokens + cacheReadTokens;

        currentTurn.freshInputTokens += inputTokens;
        currentTurn.cacheReadTokens += cacheReadTokens;
        currentTurn.thinkingTokens += thinkingTokens;
        currentTurn.visibleOutputTokens += visibleOutputTokens;
        currentTurn.outputTokens += outputTokens;
        currentTurn.contextAfter = stepContextTokens;
        currentTurn._hasTokenStep = true;
      }

      currentTurn.steps.push({
        stepNumber: currentTurn.steps.length + 1,
        type: 'PLANNER_RESPONSE',
        model: modelName || 'Bilinmiyor',
        inputTokens: inputTokensOrZero,
        cacheReadTokens: cacheReadTokensOrZero,
        contextTokens: stepContextTokens,
        thinkingTokens: thinkingTokensOrZero,
        visibleOutputTokens: visibleOutputTokensOrZero,
        outputTokens: outputTokensOrZero,
      });
    }
  }

  finalizeTurn(currentTurn);

  const totals = { ...emptyTotals };
  for (const turn of turns) {
    if (!turn.isPreUser) {
      totals.messageCount += 1;
    }
    totals.userPromptTokensEst += turn.userPromptTokensEst;
    totals.thinkingTokens += turn.thinkingTokens;
    totals.visibleOutputTokens += turn.visibleOutputTokens;
    totals.outputTokens += turn.outputTokens;
    totals.freshInputTokens += turn.freshInputTokens;
    totals.cacheReadTokens += turn.cacheReadTokens;
    totals.totalProcessedTokens += turn.totalProcessedTokens;
  }

  const timeline = {
    conversationId: id,
    title,
    hasThinkingSplit,
    totals,
    turns,
  };

  tracker._timelineCache.set(id, { key: cacheKey, timeline });
  return timeline;
}

module.exports = {
  buildMessageTimeline,
};
