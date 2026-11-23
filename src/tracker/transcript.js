'use strict';

/**
 * Incremental reader and tail-preview scanner for Antigravity `transcript.jsonl` files.
 * Tracks per-conversation byte offsets, UTF-8 streaming decoder state, compaction checkpoints,
 * and per-user-turn context growth.
 *
 * Exports:
 * - `TAIL_PREVIEW_BYTES`, `TAIL_PREVIEW_MAX_BYTES`
 * - `createEmptyTranscriptState`, `getTranscriptPath`
 * - `readTranscriptIncremental`, `readTranscriptIntoState`
 * - `processTranscriptLine`, `applyTranscriptRecord`
 * - `readTranscriptTailPreview`, `scanTranscriptTail`
 */

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const TAIL_PREVIEW_BYTES = 64 * 1024;
const TAIL_PREVIEW_MAX_BYTES = 256 * 1024;

/**
 * Create a fresh incremental transcript reader state.
 *
 * @param {string | null} conversationId
 * @param {string | null} filePath
 */
function createEmptyTranscriptState(conversationId, filePath) {
  return {
    conversationId: conversationId || null,
    filePath: filePath || null,
    byteOffset: 0,
    partialLine: '',
    decoder: new StringDecoder('utf8'),
    hasTranscript: false,
    contextTokens: 0,
    lastInputTokens: 0,
    lastCacheReadTokens: 0,
    lastOutputTokens: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
    compactionCount: 0,
    model: null,
    models: [],
    lastUpdatedAt: null,
    seenUserInput: false,
    currentUserTurnStartContext: 0,
    lastStepContext: 0,
    positiveTurnGrowthSum: 0,
    positiveTurnGrowthCount: 0,
  };
}

/**
 * Resolve the path to a conversation's `transcript.jsonl` under `antigravityDir`.
 *
 * @param {string} antigravityDir
 * @param {string} conversationId
 * @returns {string}
 */
function getTranscriptPath(antigravityDir, conversationId) {
  return path.join(
    antigravityDir,
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
}

/**
 * Incrementally read newly appended bytes of `transcript.jsonl` into `tracker._transcript`.
 * Resets state when the conversation changes, the file disappears, or the file shrinks.
 *
 * @param {object} tracker
 * @param {string} conversationId
 * @param {string} filePath
 */
function readTranscriptIncremental(tracker, conversationId, filePath) {
  if (tracker._transcript.filePath !== filePath || tracker._transcript.conversationId !== conversationId) {
    tracker._transcript = createEmptyTranscriptState(conversationId, filePath);
  }

  const state = tracker._transcript;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    if (state.hasTranscript || state.byteOffset > 0) {
      tracker._transcript = createEmptyTranscriptState(conversationId, filePath);
    }
    return;
  }

  // If file shrank (truncated/recreated), reset and re-read from 0
  if (stat.size < state.byteOffset) {
    tracker._transcript = createEmptyTranscriptState(conversationId, filePath);
  }

  readTranscriptIntoState(tracker._transcript, stat);
}

/**
 * Read newly appended bytes from `active.filePath` starting at `active.byteOffset`.
 *
 * @param {object} active
 * @param {import('fs').Stats} [existingStat]
 */
function readTranscriptIntoState(active, existingStat) {
  const filePath = active.filePath;
  if (!filePath) {
    return;
  }

  let stat = existingStat;
  if (!stat) {
    try {
      stat = fs.statSync(filePath);
    } catch {
      active.hasTranscript = false;
      return;
    }
  }

  active.hasTranscript = true;

  const bytesToRead = stat.size - active.byteOffset;
  if (bytesToRead <= 0) {
    return;
  }

  let chunkBuf = null;
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    chunkBuf = Buffer.allocUnsafe(bytesToRead);
    let totalRead = 0;
    while (totalRead < bytesToRead) {
      const n = fs.readSync(fd, chunkBuf, totalRead, bytesToRead - totalRead, active.byteOffset + totalRead);
      if (n <= 0) {
        break;
      }
      totalRead += n;
    }
    if (totalRead < bytesToRead) {
      chunkBuf = chunkBuf.subarray(0, totalRead);
    }
    active.byteOffset += totalRead;
  } catch {
    return;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }

  if (!chunkBuf || chunkBuf.length === 0) {
    return;
  }

  const text = active.partialLine + active.decoder.write(chunkBuf);
  const lines = text.split('\n');
  const tail = lines.pop();

  for (const rawLine of lines) {
    processTranscriptLine(active, rawLine);
  }

  // Handle trailing fragment: if it's already a complete JSON object (no trailing \n),
  // consume it now; otherwise keep it in partialLine until the rest of the line arrives.
  if (tail && tail.trim()) {
    const trimmedTail = tail.trim();
    if (trimmedTail.startsWith('{') && trimmedTail.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmedTail);
        applyTranscriptRecord(active, obj);
        active.partialLine = '';
        return;
      } catch {
        // Incomplete JSON line mid-write
      }
    }
    active.partialLine = tail;
  } else {
    active.partialLine = '';
  }
}

/**
 * Parse a single transcript JSONL line and apply it to `state`.
 *
 * @param {object} state
 * @param {string} rawLine
 */
function processTranscriptLine(state, rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    return;
  }
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Gracefully skip malformed or partial lines
    return;
  }
  applyTranscriptRecord(state, obj);
}

/**
 * Apply a parsed transcript record object to `state`.
 *
 * @param {object} state
 * @param {object} obj
 */
function applyTranscriptRecord(state, obj) {
  if (!obj || typeof obj !== 'object') {
    return;
  }

  if (obj.type === 'USER_INPUT') {
    if (state.seenUserInput) {
      const delta = state.lastStepContext - state.currentUserTurnStartContext;
      if (delta > 0) {
        state.positiveTurnGrowthSum += delta;
        state.positiveTurnGrowthCount += 1;
      }
    }
    state.seenUserInput = true;
    state.currentUserTurnStartContext = state.lastStepContext;
  }

  if (obj.type === 'CHECKPOINT') {
    state.compactionCount += 1;
  }

  if (typeof obj.input_tokens === 'number' && Number.isFinite(obj.input_tokens)) {
    const inputTokens = obj.input_tokens;
    const cacheReadTokens =
      typeof obj.cache_read_tokens === 'number' && Number.isFinite(obj.cache_read_tokens)
        ? obj.cache_read_tokens
        : 0;
    const outputTokens =
      typeof obj.output_tokens === 'number' && Number.isFinite(obj.output_tokens)
        ? obj.output_tokens
        : 0;

    state.lastInputTokens = inputTokens;
    state.lastCacheReadTokens = cacheReadTokens;
    state.lastOutputTokens = outputTokens;
    state.contextTokens = inputTokens + cacheReadTokens;
    if (obj.type === 'PLANNER_RESPONSE' || obj.type === 'CHECKPOINT' || !obj.type) {
      state.lastStepContext = state.contextTokens;
    }

    state.totalInputTokens += inputTokens;
    state.totalCacheReadTokens += cacheReadTokens;
    state.totalOutputTokens += outputTokens;
    state.turnCount += 1;

    if (typeof obj.model === 'string' && obj.model.trim()) {
      const modelName = obj.model.trim();
      state.model = modelName;
      if (!Array.isArray(state.models)) {
        state.models = [];
      }
      if (!state.models.includes(modelName)) {
        state.models.push(modelName);
      }
    }
    if (typeof obj.created_at === 'string' && obj.created_at.trim()) {
      state.lastUpdatedAt = obj.created_at.trim();
    } else if (typeof obj.timestamp === 'string' && obj.timestamp.trim()) {
      state.lastUpdatedAt = obj.timestamp.trim();
    }
  }
}

/**
 * Fast cached tail-reader for conversation list previews.
 * Reads only the last 64 KB (expanding once to 256 KB if needed) and caches by (id, size, mtimeMs).
 *
 * @param {object} tracker
 * @param {string} conversationId
 * @param {string} filePath
 * @returns {{ hasTranscript: boolean, hasUsage: boolean, contextTokens: number | null, model: string | null }}
 */
function readTranscriptTailPreview(tracker, conversationId, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    tracker._tailPreviewCache.delete(conversationId);
    return { hasTranscript: false, hasUsage: false, contextTokens: null, model: null };
  }

  // Reuse live active transcript state directly when sizes match (zero file read)
  if (
    tracker._transcript.conversationId === conversationId &&
    tracker._transcript.hasTranscript &&
    tracker._transcript.byteOffset === stat.size
  ) {
    const hasUsage = tracker._transcript.turnCount > 0;
    return {
      hasTranscript: true,
      hasUsage,
      contextTokens: hasUsage ? tracker._transcript.contextTokens : null,
      model: tracker._transcript.model,
    };
  }

  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = tracker._tailPreviewCache.get(conversationId);
  if (cached && cached.key === cacheKey) {
    return {
      hasTranscript: true,
      hasUsage: cached.hasUsage,
      contextTokens: cached.contextTokens,
      model: cached.model,
    };
  }

  if (stat.size === 0) {
    const emptyEntry = { key: cacheKey, hasUsage: false, contextTokens: null, model: null };
    tracker._tailPreviewCache.set(conversationId, emptyEntry);
    return { hasTranscript: true, hasUsage: false, contextTokens: null, model: null };
  }

  let found = scanTranscriptTail(filePath, stat.size, TAIL_PREVIEW_BYTES);
  if (!found && stat.size > TAIL_PREVIEW_BYTES) {
    found = scanTranscriptTail(filePath, stat.size, TAIL_PREVIEW_MAX_BYTES);
  }

  const entry = found
    ? {
        key: cacheKey,
        hasUsage: true,
        contextTokens: found.contextTokens,
        model: found.model,
      }
    : {
        key: cacheKey,
        hasUsage: false,
        contextTokens: null,
        model: null,
      };

  tracker._tailPreviewCache.set(conversationId, entry);
  return {
    hasTranscript: true,
    hasUsage: entry.hasUsage,
    contextTokens: entry.contextTokens,
    model: entry.model,
  };
}

/**
 * Scan backwards over the last `windowBytes` of `filePath` for the latest record with `input_tokens`.
 *
 * @param {string} filePath
 * @param {number} fileSize
 * @param {number} windowBytes
 * @returns {{ contextTokens: number, model: string | null } | null}
 */
function scanTranscriptTail(filePath, fileSize, windowBytes) {
  const startPos = Math.max(0, fileSize - windowBytes);
  const bytesToRead = fileSize - startPos;
  if (bytesToRead <= 0) {
    return null;
  }

  let buf = null;
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    buf = Buffer.allocUnsafe(bytesToRead);
    let totalRead = 0;
    while (totalRead < bytesToRead) {
      const n = fs.readSync(fd, buf, totalRead, bytesToRead - totalRead, startPos + totalRead);
      if (n <= 0) {
        break;
      }
      totalRead += n;
    }
    if (totalRead < bytesToRead) {
      buf = buf.subarray(0, totalRead);
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }

  if (!buf || buf.length === 0) {
    return null;
  }

  const text = buf.toString('utf8');
  const lines = text.split('\n');
  // If we started mid-file, skip the first partial line
  const minIndex = startPos > 0 ? 1 : 0;

  for (let i = lines.length - 1; i >= minIndex; i--) {
    const rawLine = lines[i];
    if (!rawLine || !rawLine.includes('input_tokens')) {
      continue;
    }
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.input_tokens === 'number' && Number.isFinite(obj.input_tokens)) {
        const cacheRead =
          typeof obj.cache_read_tokens === 'number' && Number.isFinite(obj.cache_read_tokens)
            ? obj.cache_read_tokens
            : 0;
        const model = typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : null;
        return {
          contextTokens: obj.input_tokens + cacheRead,
          model,
        };
      }
    } catch {
      // Ignore partial/malformed line
    }
  }

  return null;
}

module.exports = {
  TAIL_PREVIEW_BYTES,
  TAIL_PREVIEW_MAX_BYTES,
  createEmptyTranscriptState,
  getTranscriptPath,
  readTranscriptIncremental,
  readTranscriptIntoState,
  processTranscriptLine,
  applyTranscriptRecord,
  readTranscriptTailPreview,
  scanTranscriptTail,
};
