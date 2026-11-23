'use strict';

/**
 * Loaders and mergers for Antigravity conversation summaries (`agyhub_summaries_proto.pb`)
 * and per-conversation annotation files (`annotations/*.pbtxt`).
 */

const fs = require('fs');
const path = require('path');
const { parseSummariesProto, parseAnnotationPbtxt } = require('../proto');

/**
 * Check whether a summary represents a subagent / swarm worker rather than a top-level chat.
 *
 * @param {{ parentConversationId?: string, nestingDepth?: number } | null | undefined} summary
 * @returns {boolean}
 */
function isSubagentSummary(summary) {
  if (!summary) {
    return false;
  }
  return Boolean(summary.parentConversationId) || (typeof summary.nestingDepth === 'number' && summary.nestingDepth > 0);
}

/**
 * Load and cache `agyhub_summaries_proto.pb`.
 * Mutates `summariesCache` in place if provided and returns `{ key, list, byId }`.
 *
 * @param {string} antigravityDir
 * @param {{ key: string, list: Array<object>, byId: Map<string, object> }} [summariesCache]
 * @returns {{ key: string, list: Array<object>, byId: Map<string, object> }}
 */
function loadSummariesProto(antigravityDir, summariesCache) {
  const cache =
    summariesCache && typeof summariesCache === 'object'
      ? summariesCache
      : { key: '', list: [], byId: new Map() };

  if (!antigravityDir) {
    return { key: '', list: [], byId: new Map() };
  }
  const pbPath = path.join(antigravityDir, 'agyhub_summaries_proto.pb');
  let stat;
  try {
    stat = fs.statSync(pbPath);
  } catch {
    return { key: '', list: [], byId: new Map() };
  }

  const key = `${stat.mtimeMs}:${stat.size}`;
  if (key === cache.key) {
    return cache;
  }

  try {
    const buf = fs.readFileSync(pbPath);
    const parsed = parseSummariesProto(buf);
    const byId = new Map();
    for (const s of parsed) {
      byId.set(s.id, s);
    }
    cache.key = key;
    cache.list = parsed;
    cache.byId = byId;
    return { key, list: parsed, byId };
  } catch {
    return cache;
  }
}

/**
 * Load and cache `annotations/*.pbtxt` files, mutating `annotationsCache` by `mtimeMs:size`
 * and evicting deleted files.
 *
 * @param {string} antigravityDir
 * @param {Map<string, { key: string, id: string, lastUserViewMs: number, title: string }>} [annotationsCache]
 * @returns {Map<string, { key: string, id: string, lastUserViewMs: number, title: string }>}
 */
function loadAnnotations(antigravityDir, annotationsCache) {
  const cache = annotationsCache instanceof Map ? annotationsCache : new Map();
  const result = new Map();
  if (!antigravityDir) {
    return result;
  }
  const annDir = path.join(antigravityDir, 'annotations');
  let files;
  try {
    files = fs.readdirSync(annDir);
  } catch {
    return result;
  }

  const seenFiles = new Set();

  for (const file of files) {
    if (!file.endsWith('.pbtxt')) {
      continue;
    }
    seenFiles.add(file);
    const fullPath = path.join(annDir, file);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    const key = `${stat.mtimeMs}:${stat.size}`;
    const cached = cache.get(file);
    if (cached && cached.key === key) {
      result.set(cached.id, cached);
      continue;
    }

    try {
      const text = fs.readFileSync(fullPath, 'utf8');
      const id = file.slice(0, -'.pbtxt'.length);
      const parsed = parseAnnotationPbtxt(text);
      const entry = {
        key,
        id,
        lastUserViewMs: parsed.lastUserViewMs,
        title: parsed.title,
      };
      cache.set(file, entry);
      result.set(id, entry);
    } catch {
      // Ignore transient read errors
    }
  }

  // Evict removed files from cache
  for (const cachedFile of cache.keys()) {
    if (!seenFiles.has(cachedFile)) {
      cache.delete(cachedFile);
    }
  }

  return result;
}

/**
 * Load summaries and merge title / lastUserViewMs fields from annotations.
 *
 * @param {string} antigravityDir
 * @param {{ key: string, list: Array<object>, byId: Map<string, object> }} [summariesCache]
 * @param {Map<string, object>} [annotationsCache]
 * @returns {{ list: Array<object>, byId: Map<string, object> }}
 */
function loadSummariesWithAnnotations(antigravityDir, summariesCache, annotationsCache) {
  const { list: baseList } = loadSummariesProto(antigravityDir, summariesCache);
  const annotations = loadAnnotations(antigravityDir, annotationsCache);

  const list = [];
  const byId = new Map();

  for (const item of baseList) {
    const ann = annotations.get(item.id);
    const merged = ann
      ? {
          ...item,
          title: item.title || ann.title || '',
          lastUserViewMs: Math.max(item.lastUserViewMs || 0, ann.lastUserViewMs || 0),
        }
      : item;
    list.push(merged);
    byId.set(merged.id, merged);
  }

  return { list, byId };
}

module.exports = {
  isSubagentSummary,
  loadSummariesProto,
  loadAnnotations,
  loadSummariesWithAnnotations,
};
