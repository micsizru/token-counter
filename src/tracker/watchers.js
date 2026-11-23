'use strict';

/**
 * File-system watchers, debounced refresh scheduling, and focus-aware safety polling
 * for `TokenTracker`.
 *
 * Exports:
 * - `DEBOUNCE_MS`, `SAFETY_INTERVAL_MS`
 * - `attachStaticWatchers`, `ensureTranscriptWatcher`
 * - `safeWatch`, `closeWatcher`
 * - `scheduleRefresh`, `clearDebounceTimer`
 * - `syncSafetyTimer`, `clearSafetyTimer`
 */

const fs = require('fs');
const path = require('path');

const DEBOUNCE_MS = 300;
const SAFETY_INTERVAL_MS = 5000;

/**
 * Attach watchers for `state.vscdb*`, `agyhub_summaries_proto.pb`, and `annotations/*.pbtxt`.
 *
 * @param {object} tracker
 */
function attachStaticWatchers(tracker) {
  // 1. Parent directory of workspaceStateDbPath (filter only state.vscdb*)
  if (tracker.workspaceStateDbPath && !tracker._wsStateWatcher) {
    const wsDir = path.dirname(tracker.workspaceStateDbPath);
    tracker._wsStateWatcher = safeWatch(wsDir, (_eventType, filename) => {
      if (!filename) {
        scheduleRefresh(tracker);
        return;
      }
      const name = String(filename).toLowerCase();
      if (name.startsWith('state.vscdb')) {
        scheduleRefresh(tracker);
      }
    });
  }

  // 2. antigravityDir (filter ONLY agyhub_summaries_proto.pb)
  if (tracker.antigravityDir && !tracker._summariesWatcher) {
    tracker._summariesWatcher = safeWatch(tracker.antigravityDir, (_eventType, filename) => {
      if (!filename) {
        return;
      }
      if (String(filename).toLowerCase() === 'agyhub_summaries_proto.pb') {
        scheduleRefresh(tracker);
      }
    });
  }

  // 3. annotations directory
  if (tracker.antigravityDir && !tracker._annotationsWatcher) {
    const annDir = path.join(tracker.antigravityDir, 'annotations');
    tracker._annotationsWatcher = safeWatch(annDir, (_eventType, filename) => {
      if (!filename || String(filename).toLowerCase().endsWith('.pbtxt')) {
        scheduleRefresh(tracker);
      }
    });
  }
}

/**
 * Ensure a watcher is attached to `transcriptPath` if it exists, or its nearest existing ancestor.
 *
 * @param {object} tracker
 * @param {string} conversationId
 * @param {string} transcriptPath
 */
function ensureTranscriptWatcher(tracker, conversationId, transcriptPath) {
  // Prefer watching transcript.jsonl directly if it exists; otherwise watch nearest existing parent dir
  let target = null;
  let isFile = false;

  try {
    if (fs.existsSync(transcriptPath)) {
      target = transcriptPath;
      isFile = true;
    } else {
      const candidates = [
        path.dirname(transcriptPath), // logs
        path.dirname(path.dirname(transcriptPath)), // .system_generated
        path.join(tracker.antigravityDir, 'brain', conversationId),
      ];
      for (const dir of candidates) {
        if (fs.existsSync(dir)) {
          target = dir;
          isFile = false;
          break;
        }
      }
    }
  } catch {
    target = null;
  }

  const watchKey = target ? `${isFile ? 'F' : 'D'}:${target}` : null;
  if (watchKey === tracker._transcriptWatchedTarget) {
    return;
  }

  closeWatcher(tracker, '_transcriptWatcher');
  tracker._transcriptWatchedTarget = null;

  if (!target) {
    return;
  }

  const watcher = safeWatch(target, (_eventType, filename) => {
    if (isFile) {
      scheduleRefresh(tracker);
      return;
    }
    if (!filename) {
      scheduleRefresh(tracker);
      return;
    }
    const lower = String(filename).toLowerCase();
    if (lower === 'transcript.jsonl' || lower === 'logs' || lower === '.system_generated') {
      scheduleRefresh(tracker);
    }
  });

  if (watcher) {
    tracker._transcriptWatcher = watcher;
    tracker._transcriptWatchedTarget = watchKey;
  }
}

/**
 * Watch `targetPath` non-persistently and swallow transient OS watcher errors.
 *
 * @param {string} targetPath
 * @param {(eventType: string, filename: string | Buffer | null) => void} listener
 * @returns {import('fs').FSWatcher | null}
 */
function safeWatch(targetPath, listener) {
  try {
    if (!fs.existsSync(targetPath)) {
      return null;
    }
    const watcher = fs.watch(targetPath, { persistent: false }, listener);
    watcher.on('error', () => {
      // Ignore transient watcher errors on Windows (e.g., deleted dir / EPERM)
    });
    return watcher;
  } catch {
    return null;
  }
}

/**
 * Close and clear a watcher property on `tracker`.
 *
 * @param {object} tracker
 * @param {string} propName
 */
function closeWatcher(tracker, propName) {
  const watcher = tracker[propName];
  if (watcher) {
    tracker[propName] = null;
    try {
      watcher.close();
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * Schedule a debounced `tracker.refresh(false)`.
 *
 * @param {object} tracker
 */
function scheduleRefresh(tracker) {
  if (!tracker._running || tracker._disposed) {
    return;
  }
  if (tracker._debounceTimer) {
    clearTimeout(tracker._debounceTimer);
  }
  tracker._debounceTimer = setTimeout(() => {
    tracker._debounceTimer = null;
    if (tracker._running && !tracker._disposed) {
      tracker.refresh(false);
    }
  }, DEBOUNCE_MS);
}

/**
 * Cancel any pending debounce timer on `tracker`.
 *
 * @param {object} tracker
 */
function clearDebounceTimer(tracker) {
  if (tracker._debounceTimer) {
    clearTimeout(tracker._debounceTimer);
    tracker._debounceTimer = null;
  }
}

/**
 * Start or stop the 5-second safety polling timer based on running/focus/disposed flags.
 *
 * @param {object} tracker
 */
function syncSafetyTimer(tracker) {
  if (tracker._running && tracker._windowFocused && !tracker._disposed) {
    if (!tracker._safetyTimer) {
      tracker._safetyTimer = setInterval(() => {
        if (tracker._running && tracker._windowFocused && !tracker._disposed) {
          tracker.refresh(false);
        }
      }, SAFETY_INTERVAL_MS);
    }
  } else {
    clearSafetyTimer(tracker);
  }
}

/**
 * Cancel any active safety polling timer on `tracker`.
 *
 * @param {object} tracker
 */
function clearSafetyTimer(tracker) {
  if (tracker._safetyTimer) {
    clearInterval(tracker._safetyTimer);
    tracker._safetyTimer = null;
  }
}

module.exports = {
  DEBOUNCE_MS,
  SAFETY_INTERVAL_MS,
  attachStaticWatchers,
  ensureTranscriptWatcher,
  safeWatch,
  closeWatcher,
  scheduleRefresh,
  clearDebounceTimer,
  syncSafetyTimer,
  clearSafetyTimer,
};
