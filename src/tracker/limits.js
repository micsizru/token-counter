'use strict';

/**
 * Context limit and model display-name resolution for active conversations and list previews.
 * Uses conversation SQLite metadata with WAL-aware caching, user `modelLimits`, `DEFAULT_MODEL_LIMITS`,
 * and `defaultContextLimit` fallback.
 *
 * Exports:
 * - `resolveContextLimitAndDisplayName`
 * - `resolvePreviewLimitAndDisplayName`
 */

const path = require('path');
const { DEFAULT_MODEL_LIMITS, matchModelLimit } = require('./metrics');
const { getSqliteStatKey, queryConversationDbMetadata } = require('./sqlite');

/**
 * Resolve the effective context limit, limit source, model display name, and DB models list
 * for a conversation, caching SQLite queries in `tracker._convDbCache` and `tracker._convDbById`.
 *
 * @param {object} tracker
 * @param {string} conversationId
 * @param {string | null} model
 * @param {number} turnCount
 * @returns {{ limit: number, source: string, displayName: string | null, dbModels: string[] }}
 */
function resolveContextLimitAndDisplayName(tracker, conversationId, model, turnCount) {
  const convDbPath = path.join(tracker.antigravityDir, 'conversations', `${conversationId}.db`);
  const statInfo = getSqliteStatKey(convDbPath);
  const currentMtimeMs = statInfo ? statInfo.mtimeMs : 0;
  const currentStatKey = statInfo ? statInfo.key : '';
  const turns = typeof turnCount === 'number' && Number.isFinite(turnCount) ? turnCount : 0;

  let dbInfo = tracker._convDbCache.get(conversationId);

  // Re-query whenever uncached, new turns arrived, or the .db / -wal file changed on disk
  const shouldQueryDb =
    !dbInfo ||
    turns > dbInfo.checkedTurnCount ||
    currentMtimeMs !== dbInfo.mtimeMs ||
    currentStatKey !== dbInfo.statKey;

  if (shouldQueryDb) {
    dbInfo = queryConversationDbMetadata(
      tracker.antigravityDir,
      conversationId,
      turns,
      convDbPath,
      statInfo
    );
    tracker._convDbCache.set(conversationId, dbInfo);
    if (dbInfo.dbLimit || dbInfo.dbDisplayName) {
      tracker._convDbById.set(conversationId, {
        dbLimit: dbInfo.dbLimit,
        dbDisplayName: dbInfo.dbDisplayName,
      });
    }
  }

  const displayName = dbInfo.dbDisplayName || null;
  const dbModels = Array.isArray(dbInfo.dbModels) ? dbInfo.dbModels : [];

  // 1. Conversation DB executor_metadata context budget
  if (dbInfo.dbLimit && dbInfo.dbLimit > 0) {
    return {
      limit: dbInfo.dbLimit,
      source: 'db',
      displayName,
      dbModels,
    };
  }

  // 2. Model table match: user config.modelLimits first, then DEFAULT_MODEL_LIMITS
  if (model) {
    const userLimit = matchModelLimit(model, tracker.config.modelLimits);
    if (userLimit && userLimit > 0) {
      return {
        limit: userLimit,
        source: 'model-table',
        displayName,
        dbModels,
      };
    }
    const defaultTableLimit = matchModelLimit(model, DEFAULT_MODEL_LIMITS);
    if (defaultTableLimit && defaultTableLimit > 0) {
      return {
        limit: defaultTableLimit,
        source: 'model-table',
        displayName,
        dbModels,
      };
    }
  }

  // 3. Default context limit from config
  return {
    limit: tracker.config.defaultContextLimit,
    source: 'default',
    displayName,
    dbModels,
  };
}

/**
 * Resolve context limit & display name for list previews WITHOUT opening SQLite DBs.
 * Uses already-cached DB metadata -> model table -> defaultContextLimit.
 *
 * @param {object} tracker
 * @param {string} conversationId
 * @param {string | null} model
 * @returns {{ limit: number, displayName: string | null }}
 */
function resolvePreviewLimitAndDisplayName(tracker, conversationId, model) {
  const cachedDb = tracker._convDbById.get(conversationId) || null;
  const displayName = cachedDb && cachedDb.dbDisplayName ? cachedDb.dbDisplayName : null;

  if (cachedDb && cachedDb.dbLimit && cachedDb.dbLimit > 0) {
    return { limit: cachedDb.dbLimit, displayName };
  }

  if (model) {
    const userLimit = matchModelLimit(model, tracker.config.modelLimits);
    if (userLimit && userLimit > 0) {
      return { limit: userLimit, displayName };
    }
    const defaultTableLimit = matchModelLimit(model, DEFAULT_MODEL_LIMITS);
    if (defaultTableLimit && defaultTableLimit > 0) {
      return { limit: defaultTableLimit, displayName };
    }
  }

  return { limit: tracker.config.defaultContextLimit, displayName };
}

module.exports = {
  resolveContextLimitAndDisplayName,
  resolvePreviewLimitAndDisplayName,
};
