'use strict';

/**
 * Read-only SQLite accessors for VS Code workspace/global state databases and Antigravity conversation DBs.
 * Exports WAL-aware stat helpers, one-shot query wrappers, and metadata/usage extractors.
 */

const fs = require('fs');
const path = require('path');
const {
  parseExecutorContextBudget,
  parseGenModelDisplayName,
  parseGenMetadataUsage,
} = require('../proto');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

/**
 * Safe one-shot read-only SQLite query helper. Never leaves a database handle open.
 *
 * @template T
 * @param {string | null | undefined} dbPath
 * @param {(db: any) => T} queryFn
 * @returns {T | null}
 */
function querySqliteOneShot(dbPath, queryFn) {
  if (!DatabaseSync || !dbPath || typeof dbPath !== 'string') {
    return null;
  }
  try {
    if (!fs.existsSync(dbPath)) {
      return null;
    }
  } catch {
    return null;
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return queryFn(db);
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Build a cache key covering both the main SQLite file and its `-wal` sibling
 * so uncommitted WAL updates invalidate the cache immediately.
 *
 * @param {string} dbPath
 * @returns {{ key: string, mtimeMs: number } | null}
 */
function getSqliteStatKey(dbPath) {
  try {
    const mainStat = fs.statSync(dbPath);
    let mtimeMs = mainStat.mtimeMs;
    let walPart = '';
    try {
      const walStat = fs.statSync(dbPath + '-wal');
      walPart = `|${walStat.mtimeMs}:${walStat.size}`;
      if (walStat.mtimeMs > mtimeMs) {
        mtimeMs = walStat.mtimeMs;
      }
    } catch {
      // No WAL file present
    }
    return {
      key: `${mainStat.mtimeMs}:${mainStat.size}${walPart}`,
      mtimeMs,
    };
  } catch {
    return null;
  }
}

/**
 * Safely parse a JSON string or pass through an already-parsed object.
 *
 * @param {any} value
 * @returns {any}
 */
function parseJsonLoose(value) {
  if (value && typeof value === 'object') {
    return value;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Read the last active conversation ID from a workspace `state.vscdb` file, using WAL-aware caching.
 * Mutates `cache` in place if provided and returns `{ key, lastConversationId, mtimeMs }`.
 *
 * @param {string | null | undefined} workspaceStateDbPath
 * @param {{ key: string, lastConversationId: string | null, mtimeMs: number }} [cache]
 * @returns {{ key: string, lastConversationId: string | null, mtimeMs: number }}
 */
function readWorkspaceLastConversationId(workspaceStateDbPath, cache) {
  if (!workspaceStateDbPath) {
    return { key: '', lastConversationId: null, mtimeMs: 0 };
  }

  const statKey = getSqliteStatKey(workspaceStateDbPath);
  if (!statKey) {
    return { key: '', lastConversationId: null, mtimeMs: 0 };
  }
  if (cache && typeof cache === 'object' && statKey.key === cache.key) {
    return {
      key: cache.key,
      lastConversationId: cache.lastConversationId,
      mtimeMs: cache.mtimeMs,
    };
  }

  const lastConversationId = querySqliteOneShot(workspaceStateDbPath, (db) => {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'google.google-antigravity'")
      .get();
    if (!row || typeof row.value !== 'string') {
      return null;
    }
    const parsed = parseJsonLoose(row.value);
    if (parsed && typeof parsed.lastConversationId === 'string' && parsed.lastConversationId.trim()) {
      return parsed.lastConversationId.trim();
    }
    return null;
  });

  const next = {
    key: statKey.key,
    lastConversationId: lastConversationId || null,
    mtimeMs: statKey.mtimeMs,
  };
  if (cache && typeof cache === 'object') {
    cache.key = next.key;
    cache.lastConversationId = next.lastConversationId;
    cache.mtimeMs = next.mtimeMs;
  }
  return next;
}

/**
 * Read open aux-pane conversation IDs from the global `state.vscdb` file, using WAL-aware caching.
 * Mutates `cache` in place if provided and returns the array of pane conversation IDs.
 *
 * @param {string | null | undefined} globalStateDbPath
 * @param {{ key: string, paneIds: string[] }} [cache]
 * @returns {string[]}
 */
function readGlobalAuxPaneConversationIds(globalStateDbPath, cache) {
  if (!globalStateDbPath) {
    return [];
  }
  const statKey = getSqliteStatKey(globalStateDbPath);
  if (!statKey) {
    return [];
  }
  if (cache && typeof cache === 'object' && statKey.key === cache.key) {
    return cache.paneIds;
  }

  const paneIds =
    querySqliteOneShot(globalStateDbPath, (db) => {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'google.google-antigravity'")
        .get();
      if (!row || typeof row.value !== 'string') {
        return [];
      }
      const parsed = parseJsonLoose(row.value);
      if (!parsed || typeof parsed !== 'object') {
        return [];
      }

      const ids = [];
      const addFromSession = (rawSession) => {
        const session = parseJsonLoose(rawSession);
        if (!session || typeof session !== 'object') {
          return;
        }
        const panes = session.conversationPanes;
        if (panes && typeof panes === 'object') {
          for (const key of Object.keys(panes)) {
            const trimmed = key.trim();
            if (trimmed && !ids.includes(trimmed)) {
              ids.push(trimmed);
            }
          }
        }
      };

      const agyStorage = parsed['antigravity-storage'];
      if (agyStorage && typeof agyStorage === 'object') {
        addFromSession(agyStorage['aux-pane-v2-session']);
        addFromSession(agyStorage['aux-pane-session']);
      }
      addFromSession(parsed['antigravity-storage.aux-pane-v2-session']);
      addFromSession(parsed['antigravity-storage.aux-pane-session']);

      return ids;
    }) || [];

  if (cache && typeof cache === 'object') {
    cache.key = statKey.key;
    cache.paneIds = paneIds;
  }
  return paneIds;
}

/**
 * Query a conversation's SQLite DB for context budget, latest model display name, and models list.
 *
 * @param {string} antigravityDir
 * @param {string} conversationId
 * @param {number} turnCount
 * @param {string} [convDbPathArg]
 * @param {{ key: string, mtimeMs: number } | null} [statInfoArg]
 * @returns {{ dbLimit: number | null, dbDisplayName: string | null, dbModels: string[], checkedTurnCount: number, mtimeMs: number, statKey: string }}
 */
function queryConversationDbMetadata(antigravityDir, conversationId, turnCount, convDbPathArg, statInfoArg) {
  const convDbPath =
    convDbPathArg || path.join(antigravityDir, 'conversations', `${conversationId}.db`);
  const statInfo = statInfoArg !== undefined ? statInfoArg : getSqliteStatKey(convDbPath);

  const result = querySqliteOneShot(convDbPath, (db) => {
    let dbLimit = null;
    let dbDisplayName = null;
    const dbModels = [];
    const seenModelKeys = new Set();

    try {
      const emRow = db
        .prepare('SELECT data FROM executor_metadata ORDER BY idx DESC LIMIT 1')
        .get();
      if (emRow && emRow.data) {
        dbLimit = parseExecutorContextBudget(Buffer.from(emRow.data));
      }
    } catch {
      // Table may not exist in legacy/empty DBs
    }

    try {
      const gmRows = db
        .prepare('SELECT data FROM gen_metadata ORDER BY idx ASC')
        .all();
      for (const gmRow of gmRows) {
        if (!gmRow || !gmRow.data) {
          continue;
        }
        const name = parseGenModelDisplayName(Buffer.from(gmRow.data));
        if (typeof name === 'string' && name.trim()) {
          const trimmed = name.trim();
          dbDisplayName = trimmed;
          const normKey = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '');
          if (normKey && !seenModelKeys.has(normKey)) {
            seenModelKeys.add(normKey);
            dbModels.push(trimmed);
          }
        }
      }
    } catch {
      // Table may not exist in legacy/empty DBs
    }

    return { dbLimit, dbDisplayName, dbModels };
  });

  return {
    dbLimit: result ? result.dbLimit : null,
    dbDisplayName: result ? result.dbDisplayName : null,
    dbModels: result && Array.isArray(result.dbModels) ? result.dbModels : [],
    checkedTurnCount: turnCount || 0,
    mtimeMs: statInfo ? statInfo.mtimeMs : 0,
    statKey: statInfo ? statInfo.key : '',
  };
}

/**
 * Query `gen_metadata` rows from a conversation DB for message timeline thinking/output splits.
 *
 * @param {string} convDbPath
 * @returns {Array<{ usage: object | null, displayName: string | null }>}
 */
function queryGenMetadataUsage(convDbPath) {
  return (
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
    }) || []
  );
}

module.exports = {
  querySqliteOneShot,
  getSqliteStatKey,
  parseJsonLoose,
  readWorkspaceLastConversationId,
  readGlobalAuxPaneConversationIds,
  queryConversationDbMetadata,
  queryGenMetadataUsage,
};
