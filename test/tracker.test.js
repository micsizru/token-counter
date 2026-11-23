'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');

const proto = require('../src/proto');
const { TokenTracker, DEFAULT_MODEL_LIMITS, formatTokenCount, getEfficiencyStatus } = require('../src/tracker');
const { TokenSayarViews, VIEW_IDS, buildThresholdBar } = require('../src/views');

// ---------------------------------------------------------------------------
// Synthetic Protobuf Encoder Helpers (for deterministic unit tests)
// ---------------------------------------------------------------------------

function encodeVarint(value) {
  let n = BigInt(value);
  if (n < 0n) {
    throw new RangeError('Unsigned varint expected');
  }
  const bytes = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) {
      b |= 0x80;
    }
    bytes.push(b);
  } while (n > 0n);
  return Buffer.from(bytes);
}

function encodeTag(field, wire) {
  return encodeVarint((BigInt(field) << 3n) | BigInt(wire));
}

function pbVarint(field, value) {
  return Buffer.concat([encodeTag(field, proto.WIRE_VARINT), encodeVarint(value)]);
}

function pbBytes(field, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  return Buffer.concat([encodeTag(field, proto.WIRE_LENGTH_DELIMITED), encodeVarint(buf.length), buf]);
}

function pbFixed64(field, valBuffer) {
  return Buffer.concat([encodeTag(field, proto.WIRE_64BIT), valBuffer]);
}

function pbFixed32(field, valBuffer) {
  return Buffer.concat([encodeTag(field, proto.WIRE_32BIT), valBuffer]);
}

function pbTimestamp(seconds, nanos = 0) {
  const parts = [];
  if (seconds) {
    parts.push(pbVarint(1, seconds));
  }
  if (nanos) {
    parts.push(pbVarint(2, nanos));
  }
  return Buffer.concat(parts);
}

function buildSummaryEntry({
  id,
  title = '',
  stepCount = 0,
  lastModifiedSec = 0,
  status = 1,
  workspaceUri = '',
  lastUserInputSec = 0,
  annotationTitle = '',
  lastUserViewSec = 0,
  parentConversationId = '',
  encodedWorkspaceUri = '',
  nestingDepth = 0,
}) {
  const summaryParts = [];
  if (title) summaryParts.push(pbBytes(1, title));
  if (stepCount) summaryParts.push(pbVarint(2, stepCount));
  if (lastModifiedSec) summaryParts.push(pbBytes(3, pbTimestamp(lastModifiedSec, 500_000_000)));
  if (status) summaryParts.push(pbVarint(5, status));
  if (workspaceUri) summaryParts.push(pbBytes(9, pbBytes(1, workspaceUri)));
  if (lastUserInputSec) summaryParts.push(pbBytes(10, pbTimestamp(lastUserInputSec, 0)));
  if (annotationTitle || lastUserViewSec) {
    const annParts = [];
    if (annotationTitle) annParts.push(pbBytes(1, annotationTitle));
    if (lastUserViewSec) annParts.push(pbBytes(7, pbTimestamp(lastUserViewSec, 0)));
    summaryParts.push(pbBytes(15, Buffer.concat(annParts)));
  }
  if (parentConversationId || encodedWorkspaceUri || nestingDepth) {
    const trajParts = [];
    if (parentConversationId) trajParts.push(pbBytes(5, parentConversationId));
    if (encodedWorkspaceUri) trajParts.push(pbBytes(7, encodedWorkspaceUri));
    if (nestingDepth) trajParts.push(pbVarint(17, nestingDepth));
    summaryParts.push(pbBytes(17, Buffer.concat(trajParts)));
  }
  return pbBytes(1, Buffer.concat([pbBytes(1, id), pbBytes(2, Buffer.concat(summaryParts))]));
}

function buildExecutorMetadata(budget) {
  return pbBytes(10, pbBytes(2, pbVarint(5, budget)));
}

function buildGenMetadata(displayName) {
  return pbBytes(1, pbBytes(21, displayName));
}

function buildGenMetadataWithUsage({
  displayName = '',
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  thinkingTokens = null,
  visibleOutputTokens = null,
} = {}) {
  const f4Parts = [];
  if (inputTokens) f4Parts.push(pbVarint(2, inputTokens));
  if (outputTokens) f4Parts.push(pbVarint(3, outputTokens));
  if (cacheReadTokens) f4Parts.push(pbVarint(5, cacheReadTokens));
  if (thinkingTokens !== null) f4Parts.push(pbVarint(9, thinkingTokens));
  if (visibleOutputTokens !== null) f4Parts.push(pbVarint(10, visibleOutputTokens));
  const f1Parts = [pbBytes(4, Buffer.concat(f4Parts))];
  if (displayName) f1Parts.push(pbBytes(21, displayName));
  return pbBytes(1, Buffer.concat(f1Parts));
}

// ---------------------------------------------------------------------------
// Temp Fixture Helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix = 'token-sayar-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDirSafe(dirPath) {
  if (!dirPath) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore Windows delayed handle release in cleanup
  }
}

function createStateDb(dbPath, itemValueObj) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    const stmt = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
    stmt.run('google.google-antigravity', JSON.stringify(itemValueObj));
  } finally {
    db.close();
  }
}

function createConversationDb(dbPath, { contextBudget = null, modelDisplayName = null } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    if (contextBudget !== null) {
      db.exec('CREATE TABLE IF NOT EXISTS executor_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(
        1,
        buildExecutorMetadata(contextBudget)
      );
    }
    if (modelDisplayName !== null) {
      db.exec('CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
        1,
        buildGenMetadata(modelDisplayName)
      );
    }
  } finally {
    db.close();
  }
}

function writeTranscript(antigravityDir, convId, content) {
  const filePath = path.join(antigravityDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeAnnotation(antigravityDir, convId, { seconds = 0, nanos = 0, title = '' }) {
  const filePath = path.join(antigravityDir, 'annotations', `${convId}.pbtxt`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [];
  if (seconds > 0) {
    lines.push(`last_user_view_time: { seconds: ${seconds} nanos: ${nanos} }`);
  }
  if (title) {
    lines.push(`title: ${JSON.stringify(title)}`);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// 1. Protobuf Wire Decoder & Antigravity Parsers
// ---------------------------------------------------------------------------

test('proto: decodeFields decodes varint, BigInt varint, 64-bit, 32-bit, and length-delimited fields', () => {
  const bigVal = (1n << 50n) + 12345n;
  const f64 = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const f32 = Buffer.from([9, 10, 11, 12]);
  const msg = Buffer.concat([
    pbVarint(1, 42),
    pbVarint(2, bigVal),
    pbFixed64(3, f64),
    pbBytes(4, 'merhaba dünya'),
    pbFixed32(5, f32),
  ]);

  const fields = proto.decodeFields(msg);
  assert.equal(fields.length, 5);
  assert.deepEqual(fields[0], { field: 1, wire: proto.WIRE_VARINT, value: 42n });
  assert.deepEqual(fields[1], { field: 2, wire: proto.WIRE_VARINT, value: bigVal });
  assert.equal(fields[2].field, 3);
  assert.equal(fields[2].wire, proto.WIRE_64BIT);
  assert.ok(fields[2].value.equals(f64));
  assert.equal(fields[3].field, 4);
  assert.equal(fields[3].wire, proto.WIRE_LENGTH_DELIMITED);
  assert.equal(fields[3].value.toString('utf8'), 'merhaba dünya');
  assert.equal(fields[4].field, 5);
  assert.equal(fields[4].wire, proto.WIRE_32BIT);
  assert.ok(fields[4].value.equals(f32));
});

test('proto: truncated, corrupted, and malformed buffers never throw', () => {
  const valid = Buffer.concat([
    buildSummaryEntry({
      id: 'conv-1',
      title: 'Test Sohbet',
      stepCount: 12,
      lastModifiedSec: 1700000100,
      status: 2,
      workspaceUri: 'file:///c%3A/github-pro-repos/token-sayar',
      lastUserInputSec: 1700000090,
      lastUserViewSec: 1700000110,
    }),
  ]);

  // Every prefix truncation must succeed without throwing
  for (let len = 0; len <= valid.length; len++) {
    const slice = valid.subarray(0, len);
    assert.doesNotThrow(() => proto.decodeFields(slice));
    assert.doesNotThrow(() => proto.parseSummariesProto(slice));
    assert.doesNotThrow(() => proto.parseExecutorContextBudget(slice));
    assert.doesNotThrow(() => proto.parseGenModelDisplayName(slice));
  }

  // Adversarial payloads: overlong varint (>10 bytes), absurd length-delimited claim, invalid wire type, null/empty
  const adversarial = [
    null,
    undefined,
    Buffer.alloc(0),
    Buffer.alloc(16, 0xff),
    Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0x07]), // huge length
    Buffer.from([0x0e, 0x01, 0x02]), // wire type 6 (invalid)
    Buffer.from([0x00, 0x01]), // field 0 (invalid)
    Buffer.from([0x0b, 0x0c]), // start/end group
  ];
  for (const buf of adversarial) {
    assert.doesNotThrow(() => proto.decodeFields(buf));
    assert.doesNotThrow(() => proto.parseSummariesProto(buf));
    assert.doesNotThrow(() => proto.parseExecutorContextBudget(buf));
    assert.doesNotThrow(() => proto.parseGenModelDisplayName(buf));
  }
});

test('proto: parseSummariesProto, executor budget, gen display name, annotation pbtxt, and uriToFsPath', () => {
  const buf = Buffer.concat([
    buildSummaryEntry({
      id: 'main-uuid',
      title: 'Ana Sohbet',
      stepCount: 44,
      lastModifiedSec: 1700000200,
      status: 2,
      workspaceUri: 'file:///c%3A/github-pro-repos/token-sayar',
      lastUserInputSec: 1700000180,
      lastUserViewSec: 1700000220,
    }),
    buildSummaryEntry({
      id: 'sub-uuid',
      annotationTitle: 'Alt Ajan',
      stepCount: 5,
      lastModifiedSec: 1700000300,
      status: 1,
      encodedWorkspaceUri: 'file:///C:/github-pro-repos/token-sayar',
      parentConversationId: 'main-uuid',
      nestingDepth: 1,
    }),
  ]);

  const parsed = proto.parseSummariesProto(buf);
  assert.equal(parsed.length, 2);

  assert.equal(parsed[0].id, 'main-uuid');
  assert.equal(parsed[0].title, 'Ana Sohbet');
  assert.equal(parsed[0].stepCount, 44);
  assert.equal(parsed[0].lastModifiedMs, 1700000200500);
  assert.equal(parsed[0].status, 'running');
  assert.equal(parsed[0].lastUserInputMs, 1700000180000);
  assert.equal(parsed[0].lastUserViewMs, 1700000220000);
  assert.equal(parsed[0].parentConversationId, '');
  assert.equal(parsed[0].nestingDepth, 0);
  assert.equal(
    parsed[0].workspacePath.toLowerCase(),
    process.platform === 'win32' ? 'c:\\github-pro-repos\\token-sayar' : 'c:/github-pro-repos/token-sayar'
  );

  assert.equal(parsed[1].id, 'sub-uuid');
  assert.equal(parsed[1].title, 'Alt Ajan');
  assert.equal(parsed[1].status, 'idle');
  assert.equal(parsed[1].parentConversationId, 'main-uuid');
  assert.equal(parsed[1].nestingDepth, 1);

  assert.equal(proto.parseExecutorContextBudget(buildExecutorMetadata(512000)), 512000);
  assert.equal(proto.parseExecutorContextBudget(buildExecutorMetadata(256000)), 256000);
  assert.equal(proto.parseGenModelDisplayName(buildGenMetadata('Gemini 4 Neon (High)')), 'Gemini 4 Neon (High)');

  const ann = proto.parseAnnotationPbtxt(
    'last_user_view_time: { seconds: 1700000500 nanos: 250000000 }\ntitle: "Türkçe \\"Başlık\\""\n'
  );
  assert.equal(ann.lastUserViewMs, 1700000500250);
  assert.equal(ann.title, 'Türkçe "Başlık"');

  assert.equal(
    proto.uriToFsPath('file:///c%3A/Users/demo/My%20Repo').toLowerCase(),
    process.platform === 'win32' ? 'c:\\users\\demo\\my repo' : 'c:/users/demo/my repo'
  );
  assert.equal(proto.uriToFsPath('file:///c%ZZ/broken').includes('c%ZZ'), true);
});

test('proto: real read-only agyhub_summaries_proto.pb decodes cleanly (when present)', (t) => {
  const livePath = path.join(os.homedir(), '.gemini', 'antigravity', 'agyhub_summaries_proto.pb');
  if (!fs.existsSync(livePath)) {
    t.skip('Live agyhub_summaries_proto.pb not present on this machine');
    return;
  }

  const raw = fs.readFileSync(livePath);
  const summaries = proto.parseSummariesProto(raw);
  assert.ok(summaries.length > 0, 'Expected at least 1 conversation summary in live proto');

  for (const s of summaries) {
    assert.equal(typeof s.id, 'string');
    assert.ok(s.id.length > 0);
    assert.ok(['idle', 'running', 'unknown'].includes(s.status));
  }

  // Spot-check truncation safety on real file
  for (const frac of [0.05, 0.25, 0.5, 0.75, 0.99]) {
    const cut = Math.floor(raw.length * frac);
    assert.doesNotThrow(() => proto.parseSummariesProto(raw.subarray(0, cut)));
  }
});

// ---------------------------------------------------------------------------
// 2. Incremental transcript.jsonl Reading & Formatting
// ---------------------------------------------------------------------------

test('tracker: formatTokenCount formats small, K, and M counts accurately', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(-10), '0');
  assert.equal(formatTokenCount(NaN), '0');
  assert.equal(formatTokenCount(850), '850');
  assert.equal(formatTokenCount(1000), '1K');
  assert.equal(formatTokenCount(42310), '42.3K');
  assert.equal(formatTokenCount(100000), '100K');
  assert.equal(formatTokenCount(512000), '512K');
  assert.equal(formatTokenCount(1000000), '1M');
  assert.equal(formatTokenCount(1250000), '1.25M');
});

test('tracker: incremental transcript.jsonl reading handles chunked appends, split lines, UTF-8 split, malformed lines, shrink reset, and CHECKPOINT compaction', () => {
  const tmpDir = makeTempDir();
  try {
    const agyDir = path.join(tmpDir, 'antigravity');
    const convId = 'conv-incremental-1';
    const transcriptPath = writeTranscript(
      agyDir,
      convId,
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 10000,
        cache_read_tokens: 30000,
        output_tokens: 500,
        model: 'gemini-4-neon-high',
        created_at: '2026-11-23T05:00:00Z',
      }) + '\n'
    );

    const tracker = new TokenTracker({
      antigravityDir: agyDir,
      config: { enabled: true, defaultContextLimit: 512000 },
    });
    tracker.setPinnedConversation(convId);

    // Initial read
    let snap = tracker.refresh();
    assert.equal(snap.hasTranscript, true);
    assert.equal(snap.turnCount, 1);
    assert.equal(snap.contextTokens, 40000);
    assert.equal(snap.lastInputTokens, 10000);
    assert.equal(snap.lastCacheReadTokens, 30000);
    assert.equal(snap.lastOutputTokens, 500);
    assert.equal(snap.totalInputTokens, 10000);
    assert.equal(snap.totalCacheReadTokens, 30000);
    assert.equal(snap.totalOutputTokens, 500);
    assert.equal(snap.compactionCount, 0);
    assert.equal(snap.model, 'gemini-4-neon-high');

    // Append malformed line + first half of a split JSON line (split inside a multi-byte UTF-8 Turkish char 'ş' = C5 9F)
    const splitLineObj = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      note: 'şişiyor',
      input_tokens: 5000,
      cache_read_tokens: 55000,
      output_tokens: 700,
      model: 'gemini-4-neon-high',
      created_at: '2026-11-23T05:01:00Z',
    }) + '\n';
    const splitBuf = Buffer.from(splitLineObj, 'utf8');
    // Find byte index of 'ş' (0xC5 0x9F) and split RIGHT BETWEEN its two bytes!
    const sIdx = splitBuf.indexOf(Buffer.from([0xc5, 0x9f]));
    assert.ok(sIdx > 0, 'Expected multi-byte UTF-8 sequence in test payload');

    const part1 = Buffer.concat([Buffer.from('{not valid json\n\n', 'utf8'), splitBuf.subarray(0, sIdx + 1)]);
    const part2 = splitBuf.subarray(sIdx + 1);

    fs.appendFileSync(transcriptPath, part1);
    snap = tracker.refresh();
    // Malformed line skipped; incomplete line buffered in partialLine -> turnCount still 1
    assert.equal(snap.turnCount, 1);
    assert.equal(snap.contextTokens, 40000);

    // Append second half of split line
    fs.appendFileSync(transcriptPath, part2);
    snap = tracker.refresh();
    assert.equal(snap.turnCount, 2);
    assert.equal(snap.contextTokens, 60000);
    assert.equal(snap.totalInputTokens, 15000);
    assert.equal(snap.totalCacheReadTokens, 85000);
    assert.equal(snap.totalOutputTokens, 1200);
    assert.equal(snap.lastUpdatedAt, '2026-11-23T05:01:00Z');

    // Append CHECKPOINT compaction line + post-compaction lower-context turn
    const compactionChunk =
      JSON.stringify({
        type: 'CHECKPOINT',
        input_tokens: 3000,
        cache_read_tokens: 255000,
        output_tokens: 2000,
        model: 'gemini-4-neon-high',
      }) +
      '\n' +
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 26500,
        cache_read_tokens: 0,
        output_tokens: 400,
        model: 'gemini-4-neon-high',
      }) +
      '\n';
    fs.appendFileSync(transcriptPath, compactionChunk, 'utf8');
    snap = tracker.refresh();
    assert.equal(snap.compactionCount, 1);
    assert.equal(snap.turnCount, 4);
    assert.equal(snap.contextTokens, 26500, 'Post-compaction context should drop to latest turn');
    assert.equal(snap.lastInputTokens, 26500);
    assert.equal(snap.lastCacheReadTokens, 0);
    assert.equal(snap.totalInputTokens, 15000 + 3000 + 26500);
    assert.equal(snap.totalCacheReadTokens, 85000 + 255000);
    assert.equal(snap.totalOutputTokens, 1200 + 2000 + 400);

    // File shrink / truncation resets reader from byte 0
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 1200,
        cache_read_tokens: 800,
        output_tokens: 100,
        model: 'claude-3.7-sonnet',
      }) + '\n',
      'utf8'
    );
    snap = tracker.refresh();
    assert.equal(snap.turnCount, 1);
    assert.equal(snap.compactionCount, 0);
    assert.equal(snap.contextTokens, 2000);
    assert.equal(snap.totalInputTokens, 1200);
    assert.equal(snap.model, 'claude-3.7-sonnet');
    assert.equal(snap.contextLimit, DEFAULT_MODEL_LIMITS.claude);
    assert.equal(snap.contextLimitSource, 'model-table');

    tracker.dispose();
  } finally {
    rmDirSafe(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 3. Active Conversation Detection, Subagent Exclusion & Workspace Matching
// ---------------------------------------------------------------------------

test('tracker: excludes subagents, matches Windows workspace URIs case-insensitively, handles state.vscdb & annotations override', () => {
  const tmpDir = makeTempDir();
  try {
    const agyDir = path.join(tmpDir, 'antigravity');
    const wsStateDb = path.join(tmpDir, 'wsStorage', 'state.vscdb');
    const globalStateDb = path.join(tmpDir, 'globalStorage', 'state.vscdb');
    fs.mkdirSync(agyDir, { recursive: true });

    const nowSec = Math.floor(Date.now() / 1000);
    const summariesBuf = Buffer.concat([
      buildSummaryEntry({
        id: 'ws-main-idle',
        title: 'Main Workspace Chat',
        stepCount: 20,
        lastModifiedSec: nowSec - 100,
        status: 1,
        workspaceUri: 'file:///c%3A/Projects/TokenSayar',
        lastUserViewSec: nowSec - 100,
      }),
      buildSummaryEntry({
        id: 'ws-subagent-running',
        title: 'Swarm Subagent',
        stepCount: 5,
        lastModifiedSec: nowSec + 50,
        status: 2,
        workspaceUri: 'file:///c%3A/Projects/TokenSayar',
        parentConversationId: 'ws-main-idle',
        nestingDepth: 1,
      }),
      buildSummaryEntry({
        id: 'other-ws-running',
        title: 'Other Workspace Running Chat',
        stepCount: 30,
        lastModifiedSec: nowSec + 60,
        status: 2,
        workspaceUri: 'file:///d%3A/OtherProject',
        lastUserViewSec: nowSec + 60,
      }),
      buildSummaryEntry({
        id: 'ws-second-chat',
        title: 'Second Tab Same Workspace',
        stepCount: 8,
        lastModifiedSec: nowSec - 200,
        status: 1,
        workspaceUri: 'file:///C:/projects/tokensayar/',
      }),
    ]);
    fs.writeFileSync(path.join(agyDir, 'agyhub_summaries_proto.pb'), summariesBuf);

    // Even if workspace state.vscdb accidentally points at a subagent, subagent must be ignored!
    createStateDb(wsStateDb, { lastConversationId: 'ws-subagent-running' });
    createStateDb(globalStateDb, {
      'antigravity-storage.aux-pane-v2-session': JSON.stringify({
        conversationPanes: { 'other-ws-running': {}, 'ws-subagent-running': {} },
      }),
    });

    writeTranscript(
      agyDir,
      'ws-main-idle',
      JSON.stringify({ input_tokens: 10000, cache_read_tokens: 5000, output_tokens: 200, model: 'gemini-4-neon-high' }) +
        '\n'
    );
    writeTranscript(
      agyDir,
      'ws-second-chat',
      JSON.stringify({ input_tokens: 25000, cache_read_tokens: 5000, output_tokens: 300, model: 'gemini-4-neon-high' }) +
        '\n'
    );

    const tracker = new TokenTracker({
      antigravityDir: agyDir,
      workspaceStateDbPath: wsStateDb,
      globalStateDbPath: globalStateDb,
      workspaceFolders: ['C:\\Projects\\TokenSayar\\'],
      config: { enabled: true },
    });

    // Subagent in state.vscdb is ignored -> picks non-subagent in SAME workspace (ws-main-idle), NOT other-ws-running!
    let snap = tracker.refresh();
    assert.equal(snap.conversationId, 'ws-main-idle');
    assert.equal(snap.contextTokens, 15000);

    // listConversations excludes subagent & puts matching workspace chats first
    const list = tracker.listConversations(20);
    assert.equal(list.some((c) => c.id === 'ws-subagent-running'), false, 'Subagent must be excluded');
    assert.equal(list.length, 3);
    assert.equal(list[0].matchesWorkspace, true);
    assert.equal(list[1].matchesWorkspace, true);
    assert.equal(list[2].id, 'other-ws-running');
    assert.equal(list[2].matchesWorkspace, false);

    // Point workspace state.vscdb to ws-main-idle, then simulate a newer tab view on ws-second-chat in annotations
    createStateDb(wsStateDb, { lastConversationId: 'ws-main-idle' });
    writeAnnotation(agyDir, 'ws-second-chat', {
      seconds: nowSec + 120,
      title: 'Second Tab Same Workspace',
    });

    snap = tracker.refresh();
    assert.equal(snap.conversationId, 'ws-second-chat', 'Newer annotation view in same workspace should override stale state.vscdb');
    assert.equal(snap.contextTokens, 30000);

    // Empty window fallback uses globalStateDbPath aux-pane conversationPanes
    const emptyWinTracker = new TokenTracker({
      antigravityDir: agyDir,
      workspaceStateDbPath: null,
      globalStateDbPath: globalStateDb,
      workspaceFolders: [],
      config: { enabled: true },
    });
    const emptySnap = emptyWinTracker.refresh();
    assert.equal(emptySnap.conversationId, 'other-ws-running');

    tracker.dispose();
    emptyWinTracker.dispose();
  } finally {
    rmDirSafe(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 4. Context Limit Resolution, Bloat Levels & Custom Config
// ---------------------------------------------------------------------------

test('tracker: resolves context limits (db -> model-table -> default) and computes bloat levels with custom thresholds', () => {
  const tmpDir = makeTempDir();
  try {
    const agyDir = path.join(tmpDir, 'antigravity');
    const dbConvId = 'conv-with-db';
    const customModelConvId = 'conv-custom-model';
    const unknownModelConvId = 'conv-unknown-model';

    createConversationDb(path.join(agyDir, 'conversations', `${dbConvId}.db`), {
      contextBudget: 256000,
      modelDisplayName: 'Gemini 4 Hydrogen (Low)',
    });

    writeTranscript(
      agyDir,
      dbConvId,
      JSON.stringify({ input_tokens: 10000, cache_read_tokens: 130800, output_tokens: 500, model: 'gemini-4-hydrogen-low' }) +
        '\n'
    );
    writeTranscript(
      agyDir,
      customModelConvId,
      JSON.stringify({ input_tokens: 90000, cache_read_tokens: 0, output_tokens: 100, model: 'my-custom-llm-v2' }) +
        '\n'
    );
    writeTranscript(
      agyDir,
      unknownModelConvId,
      JSON.stringify({ input_tokens: 50000, cache_read_tokens: 0, output_tokens: 100, model: 'mystery-model' }) +
        '\n'
    );

    const tracker = new TokenTracker({
      antigravityDir: agyDir,
      config: {
        enabled: true,
        warnPercent: 55,
        dangerPercent: 80,
        defaultContextLimit: 400000,
        modelLimits: { 'my-custom-llm': 100000 },
      },
    });

    // 1) DB limit: 140800 / 256000 = 55.0% -> warn
    tracker.setPinnedConversation(dbConvId);
    let snap = tracker.refresh();
    assert.equal(snap.contextLimit, 256000);
    assert.equal(snap.contextLimitSource, 'db');
    assert.equal(snap.modelDisplayName, 'Gemini 4 Hydrogen (Low)');
    assert.equal(snap.percent, 55);
    assert.equal(snap.bloatLevel, 'warn');

    // Raise warnPercent above 55 -> ok
    tracker.updateConfig({ warnPercent: 60, dangerPercent: 85 });
    snap = tracker.refresh();
    assert.equal(snap.bloatLevel, 'ok');

    // Lower dangerPercent to 50 -> danger
    tracker.updateConfig({ warnPercent: 30, dangerPercent: 50 });
    snap = tracker.refresh();
    assert.equal(snap.bloatLevel, 'danger');

    // 2) Custom modelLimits: 90000 / 100000 = 90.0% -> danger, source: 'model-table'
    tracker.updateConfig({ warnPercent: 55, dangerPercent: 80 });
    tracker.setPinnedConversation(customModelConvId);
    snap = tracker.refresh();
    assert.equal(snap.contextLimit, 100000);
    assert.equal(snap.contextLimitSource, 'model-table');
    assert.equal(snap.percent, 90);
    assert.equal(snap.bloatLevel, 'danger');

    // 3) Default limit: 50000 / 400000 = 12.5% -> ok, source: 'default'
    tracker.setPinnedConversation(unknownModelConvId);
    snap = tracker.refresh();
    assert.equal(snap.contextLimit, 400000);
    assert.equal(snap.contextLimitSource, 'default');
    assert.equal(snap.percent, 12.5);
    assert.equal(snap.bloatLevel, 'ok');

    // 4) No transcript -> bloatLevel: 'none'
    tracker.setPinnedConversation('conv-missing-transcript');
    snap = tracker.refresh();
    assert.equal(snap.hasTranscript, false);
    assert.equal(snap.bloatLevel, 'none');

    tracker.dispose();
  } finally {
    rmDirSafe(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 5. Watcher & Timer Lifecycle (Zero Leaks)
// ---------------------------------------------------------------------------

test('tracker: watcher and timer lifecycle releases all handles on blur, stop(), and dispose()', () => {
  const tmpDir = makeTempDir();
  try {
    const agyDir = path.join(tmpDir, 'antigravity');
    const wsStateDb = path.join(tmpDir, 'wsStorage', 'state.vscdb');
    const convId = 'conv-lifecycle-1';

    fs.mkdirSync(path.join(agyDir, 'annotations'), { recursive: true });
    fs.writeFileSync(
      path.join(agyDir, 'agyhub_summaries_proto.pb'),
      buildSummaryEntry({ id: convId, title: 'Lifecycle Chat', status: 2 })
    );
    createStateDb(wsStateDb, { lastConversationId: convId });
    writeTranscript(
      agyDir,
      convId,
      JSON.stringify({ input_tokens: 1000, cache_read_tokens: 9000, output_tokens: 50, model: 'gemini-4-neon-high' }) +
        '\n'
    );

    const updates = [];
    const tracker = new TokenTracker({
      antigravityDir: agyDir,
      workspaceStateDbPath: wsStateDb,
      config: { enabled: true },
      onUpdate: (s) => updates.push(s),
    });

    tracker.start();
    assert.equal(tracker._running, true);
    assert.ok(tracker._wsStateWatcher, 'wsStateWatcher should be attached');
    assert.ok(tracker._summariesWatcher, 'summariesWatcher should be attached');
    assert.ok(tracker._annotationsWatcher, 'annotationsWatcher should be attached');
    assert.ok(tracker._transcriptWatcher, 'transcriptWatcher should be attached');
    assert.ok(tracker._safetyTimer, 'safetyTimer should be active while focused');

    // Losing focus clears safety timer immediately while keeping watchers
    tracker.setWindowFocused(false);
    assert.equal(tracker._safetyTimer, null, 'safetyTimer must be cleared when window loses focus');
    assert.ok(tracker._transcriptWatcher, 'watchers remain active while running');

    // Regaining focus restores safety timer
    tracker.setWindowFocused(true);
    assert.ok(tracker._safetyTimer, 'safetyTimer should restart when window regains focus');

    // stop() closes EVERY watcher and clears EVERY timer
    tracker.stop();
    assert.equal(tracker._running, false);
    assert.equal(tracker._wsStateWatcher, null);
    assert.equal(tracker._summariesWatcher, null);
    assert.equal(tracker._annotationsWatcher, null);
    assert.equal(tracker._transcriptWatcher, null);
    assert.equal(tracker._debounceTimer, null);
    assert.equal(tracker._safetyTimer, null);
    assert.equal(tracker.getSnapshot().enabled, false);
    assert.equal(tracker.getSnapshot().bloatLevel, 'none');

    // Direct refresh() after stop() must NOT flip enabled back to true or open watchers
    const afterStopSnap = tracker.refresh();
    assert.equal(afterStopSnap.enabled, false);
    assert.equal(tracker._transcriptWatcher, null);

    // Restart and then dispose() — dispose must NOT emit spurious onUpdate after clearing callback
    tracker.start();
    assert.ok(tracker._safetyTimer);
    const countBeforeDispose = updates.length;
    tracker.dispose();
    assert.equal(tracker._disposed, true);
    assert.equal(tracker._running, false);
    assert.equal(tracker._wsStateWatcher, null);
    assert.equal(tracker._summariesWatcher, null);
    assert.equal(tracker._annotationsWatcher, null);
    assert.equal(tracker._transcriptWatcher, null);
    assert.equal(tracker._safetyTimer, null);
    assert.equal(updates.length, countBeforeDispose, 'dispose() should not fire spurious onUpdate');
  } finally {
    rmDirSafe(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 6. Full src/extension.js + Real TokenTracker Integration Test (Mocked vscode)
// ---------------------------------------------------------------------------

function createMockVscode(initialConfig = {}, workspaceFolders = []) {
  const configState = {
    enabled: true,
    warnPercent: 55,
    dangerPercent: 80,
    defaultContextLimit: 512000,
    compactDisplay: false,
    statusBarClickAction: 'openPanel',
    modelLimits: {},
    notifications: true,
    ...initialConfig,
  };

  const commands = new Map();
  const commandMocks = new Map();
  const executedCommands = [];
  const contextKeys = new Map();
  const treeViews = new Map();
  const statusBarItems = [];
  const statusBarMessages = [];
  const warningMessages = [];
  const infoMessages = [];
  const openedTextDocuments = [];
  const shownTextDocuments = [];
  const configListeners = [];
  const windowStateListeners = [];
  const workspaceFoldersListeners = [];
  let clipboardText = '';
  let quickPickHandler = async () => undefined;
  let warningMessageHandler = async () => undefined;

  class MarkdownString {
    constructor(value = '', supportThemeIcons = false) {
      this.value = value;
      this.supportThemeIcons = supportThemeIcons;
      this.isTrusted = false;
    }
    appendText(str) {
      this.value += String(str == null ? '' : str);
      return this;
    }
    appendMarkdown(str) {
      this.value += String(str == null ? '' : str);
      return this;
    }
  }

  class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  }

  class ThemeIcon {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  }

  class TreeItem {
    constructor(label, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  class EventEmitter {
    constructor() {
      this._listeners = new Set();
      this.event = (listener) => {
        this._listeners.add(listener);
        return {
          dispose: () => {
            this._listeners.delete(listener);
          },
        };
      };
    }
    fire(data) {
      for (const listener of [...this._listeners]) {
        listener(data);
      }
    }
    dispose() {
      this._listeners.clear();
    }
  }

  const TreeItemCollapsibleState = {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  };

  const QuickPickItemKind = {
    Separator: -1,
    Default: 0,
  };

  const Uri = {
    file: (fsPath) => ({ fsPath, scheme: 'file', path: fsPath }),
    joinPath: (base, ...segments) => {
      const basePath = base && base.fsPath ? base.fsPath : (base && base.path ? base.path : '');
      const joined = path.join(basePath, ...segments);
      return { fsPath: joined, scheme: 'file', path: joined };
    },
  };

  const vscodeMock = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    TreeItemCollapsibleState,
    QuickPickItemKind,
    MarkdownString,
    ThemeColor,
    ThemeIcon,
    TreeItem,
    EventEmitter,
    Uri,
    env: {
      clipboard: {
        writeText: async (text) => {
          clipboardText = text;
        },
      },
    },
    window: {
      state: { focused: true },
      createStatusBarItem: (alignment, priority) => {
        const item = {
          alignment,
          priority,
          name: '',
          text: '',
          tooltip: null,
          command: undefined,
          backgroundColor: undefined,
          visible: false,
          disposed: false,
          show() {
            this.visible = true;
          },
          hide() {
            this.visible = false;
          },
          dispose() {
            this.disposed = true;
          },
        };
        statusBarItems.push(item);
        return item;
      },
      createTreeView: (viewId, options) => {
        const visibilityListeners = [];
        const entry = {
          viewId,
          options,
          visibilityListeners,
          disposed: false,
          view: null,
        };
        const view = {
          visible: false,
          description: undefined,
          message: undefined,
          badge: undefined,
          onDidChangeVisibility: (fn) => {
            visibilityListeners.push(fn);
            return {
              dispose() {
                const idx = visibilityListeners.indexOf(fn);
                if (idx >= 0) {
                  visibilityListeners.splice(idx, 1);
                }
              },
            };
          },
          dispose() {
            entry.disposed = true;
          },
        };
        entry.view = view;
        treeViews.set(viewId, entry);
        return view;
      },
      showQuickPick: async (items, options) => quickPickHandler(items, options),
      showWarningMessage: async (message, ...items) => {
        warningMessages.push({ message, items });
        return warningMessageHandler(message, ...items);
      },
      showInformationMessage: async (message, ...items) => {
        infoMessages.push({ message, items });
        return undefined;
      },
      showTextDocument: async (docOrUri) => {
        shownTextDocuments.push(docOrUri);
        return { document: docOrUri, uri: docOrUri };
      },
      setStatusBarMessage: (msg, timeout) => {
        statusBarMessages.push({ msg, timeout });
        return { dispose() {} };
      },
      onDidChangeWindowState: (fn) => {
        windowStateListeners.push(fn);
        return { dispose() {} };
      },
      onDidChangeWorkspaceFolders: undefined,
    },
    workspace: {
      workspaceFolders: workspaceFolders.map((fsPath) => ({ uri: { fsPath } })),
      openTextDocument: async (options) => {
        const doc = {
          uri: { scheme: 'untitled', path: 'Untitled-1', fsPath: 'Untitled-1' },
          languageId: (options && options.language) || 'plaintext',
          content: (options && options.content) || '',
          getText: () => (options && options.content) || '',
        };
        openedTextDocuments.push(doc);
        return doc;
      },
      getConfiguration: () => ({
        get: (key, defaultVal) => (key in configState ? configState[key] : defaultVal),
        inspect: (key) => ({
          key: `tokenSayar.${key}`,
          globalValue: configState[key],
          workspaceValue: undefined,
        }),
        update: async (key, value) => {
          configState[key] = value;
          const event = {
            affectsConfiguration: (section) => section === 'tokenSayar' || section === `tokenSayar.${key}`,
          };
          for (const fn of configListeners) {
            fn(event);
          }
        },
      }),
      onDidChangeConfiguration: (fn) => {
        configListeners.push(fn);
        return { dispose() {} };
      },
      onDidChangeWorkspaceFolders: (fn) => {
        workspaceFoldersListeners.push(fn);
        return { dispose() {} };
      },
    },
    commands: {
      registerCommand: (id, handler) => {
        commands.set(id, handler);
        return {
          dispose() {
            commands.delete(id);
          },
        };
      },
      executeCommand: async (id, ...args) => {
        executedCommands.push({ id, args });
        if (id === 'setContext' && args.length >= 2) {
          contextKeys.set(args[0], args[1]);
        }
        if (commandMocks.has(id)) {
          return commandMocks.get(id)(...args);
        }
        const handler = commands.get(id);
        if (handler) {
          return handler(...args);
        }
        return undefined;
      },
    },
    // Test helpers
    __state: {
      configState,
      commands,
      commandMocks,
      executedCommands,
      contextKeys,
      treeViews,
      statusBarItems,
      statusBarMessages,
      warningMessages,
      infoMessages,
      openedTextDocuments,
      shownTextDocuments,
      setQuickPickHandler: (fn) => {
        quickPickHandler = fn;
      },
      setWarningMessageHandler: (fn) => {
        warningMessageHandler = fn;
      },
      setCommandMock: (id, fn) => {
        if (fn) {
          commandMocks.set(id, fn);
        } else {
          commandMocks.delete(id);
        }
      },
      setTreeViewVisible: (viewId, visible) => {
        const entry = treeViews.get(viewId);
        if (!entry) {
          throw new Error(`Unknown treeView: ${viewId}`);
        }
        entry.view.visible = Boolean(visible);
        for (const fn of [...entry.visibilityListeners]) {
          fn({ visible: entry.view.visible });
        }
      },
      getTreeViewChildren: (viewId, element) => {
        const entry = treeViews.get(viewId);
        if (!entry) {
          throw new Error(`Unknown treeView: ${viewId}`);
        }
        return entry.options.treeDataProvider.getChildren(element);
      },
      getClipboard: () => clipboardText,
      fireConfigChange: (patch) => {
        Object.assign(configState, patch);
        const event = { affectsConfiguration: (s) => s === 'tokenSayar' };
        for (const fn of configListeners) fn(event);
      },
      fireWindowFocus: (focused) => {
        vscodeMock.window.state.focused = focused;
        for (const fn of windowStateListeners) fn({ focused });
      },
    },
  };

  return vscodeMock;
}

function loadExtensionWithMocks(vscodeMock, fakeHomeDir) {
  const origLoad = Module._load;
  const origHomedir = os.homedir;
  const extPath = require.resolve('../src/extension.js');
  delete require.cache[extPath];

  os.homedir = () => fakeHomeDir;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {
      return vscodeMock;
    }
    return origLoad.call(this, request, parent, isMain);
  };

  let ext;
  try {
    ext = require(extPath);
  } catch (err) {
    Module._load = origLoad;
    os.homedir = origHomedir;
    throw err;
  }

  return {
    ext,
    restore() {
      Module._load = origLoad;
      os.homedir = origHomedir;
      delete require.cache[extPath];
    },
  };
}

test('extension integration: status bar bloat states, compactDisplay, pinned mode, emoji-free Turkish tooltip, selectConversation, pause/resume/toggle, and deactivate()', async () => {
  const tmpDir = makeTempDir('token-sayar-ext-');
  const fakeHome = path.join(tmpDir, 'home');
  const agyDir = path.join(fakeHome, '.gemini', 'antigravity');
  const wsDir = path.join(tmpDir, 'workspace-app');
  const wsStorageExtDir = path.join(tmpDir, 'wsStorage', 'local.token-sayar');
  const wsStateDb = path.join(tmpDir, 'wsStorage', 'state.vscdb');
  const globalStorageExtDir = path.join(tmpDir, 'globalStorage', 'local.token-sayar');

  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(wsStorageExtDir, { recursive: true });
  fs.mkdirSync(globalStorageExtDir, { recursive: true });
  fs.mkdirSync(path.join(agyDir, 'annotations'), { recursive: true });

  const convId = '11111111-2222-3333-4444-555555555555';
  const conv2Id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const nowSec = Math.floor(Date.now() / 1000);
  const wsUri = 'file:///' + wsDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}%3A`);

  fs.writeFileSync(
    path.join(agyDir, 'agyhub_summaries_proto.pb'),
    Buffer.concat([
      buildSummaryEntry({
        id: convId,
        title: 'Token Sayar Test Sohbeti',
        stepCount: 15,
        lastModifiedSec: nowSec,
        status: 2,
        workspaceUri: wsUri,
        lastUserViewSec: nowSec,
      }),
      buildSummaryEntry({
        id: conv2Id,
        title: 'İkinci Sohbet',
        stepCount: 4,
        lastModifiedSec: nowSec - 60,
        status: 1,
        workspaceUri: wsUri,
      }),
    ])
  );
  createStateDb(wsStateDb, { lastConversationId: convId });
  createConversationDb(path.join(agyDir, 'conversations', `${convId}.db`), {
    contextBudget: 512000,
    modelDisplayName: 'Gemini 4 Neon (High)',
  });

  // Start in 'ok' state (~8.3% = 42,300 / 512,000)
  const transcriptPath = writeTranscript(
    agyDir,
    convId,
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      input_tokens: 2300,
      cache_read_tokens: 40000,
      output_tokens: 350,
      model: 'gemini-4-neon-high',
      created_at: '2026-11-23T05:10:00Z',
    }) + '\n'
  );

  const vscodeMock = createMockVscode({ enabled: true, compactDisplay: false }, [wsDir]);
  const loaded = loadExtensionWithMocks(vscodeMock, fakeHome);
  const context = {
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    storageUri: { fsPath: wsStorageExtDir },
    globalStorageUri: { fsPath: globalStorageExtDir },
    subscriptions: [],
  };

  try {
    loaded.ext.activate(context);
    assert.equal(vscodeMock.__state.statusBarItems.length, 1);
    assert.equal(vscodeMock.__state.contextKeys.get('tokenSayar.enabled'), true);
    const bar = vscodeMock.__state.statusBarItems[0];

    // Right alignment, priority 101, statusBarClick command (defaults to openPanel)
    assert.equal(bar.alignment, vscodeMock.StatusBarAlignment.Right);
    assert.equal(bar.priority, 101);
    assert.equal(bar.command, 'tokenSayar.statusBarClick');
    assert.equal(bar.visible, true);

    // Default statusBarClickAction ('openPanel') dispatches to tokenSayar.openPanel -> tokenSayar.context.focus
    const execCountBeforeClick = vscodeMock.__state.executedCommands.length;
    await vscodeMock.commands.executeCommand('tokenSayar.statusBarClick');
    const clickSlice = vscodeMock.__state.executedCommands.slice(execCountBeforeClick);
    assert.ok(clickSlice.some((c) => c.id === 'tokenSayar.openPanel'), 'Default click should run openPanel');
    assert.ok(
      clickSlice.some((c) => c.id === 'tokenSayar.context.focus'),
      'openPanel should focus tokenSayar.context view'
    );

    // Switching statusBarClickAction to 'openMenu' dispatches to tokenSayar.openMenu
    vscodeMock.__state.fireConfigChange({ statusBarClickAction: 'openMenu' });
    let menuQuickPickShown = false;
    vscodeMock.__state.setQuickPickHandler(async () => {
      menuQuickPickShown = true;
      return undefined;
    });
    await vscodeMock.commands.executeCommand('tokenSayar.statusBarClick');
    assert.equal(menuQuickPickShown, true, 'statusBarClick with openMenu should open QuickPick menu');
    vscodeMock.__state.fireConfigChange({ statusBarClickAction: 'openPanel' });

    // OK state rendering (Turkish comma decimals)
    assert.equal(bar.text, '$(pulse) 42,3K / 512K (%8)');
    assert.equal(bar.backgroundColor, undefined);

    // Emoji-free, ASCII-progress-bar-free Turkish tooltip content checks
    const okTip = bar.tooltip.value;
    assert.equal(/\p{Extended_Pictographic}/u.test(okTip), false, 'Tooltip must be emoji-free');
    assert.equal(/[█░▓▒]/.test(okTip), false, 'Tooltip must not contain ASCII progress bar');
    assert.ok(okTip.includes('**Token Sayar Test Sohbeti**'), 'Conversation title expected');
    assert.ok(okTip.includes('Bağlam: 42,3K / 512K (%8,3), Sağlıklı'), 'Turkish context line with comma decimals expected');
    assert.ok(okTip.includes('Model: Gemini 4 Neon (High)'), 'Model display name expected');
    assert.ok(okTip.includes('Kalan: 470K'), 'Remaining tokens expected');
    assert.ok(okTip.includes('Ayrıntılar için tıklayın.'), 'Footer hint expected');

    // Compact display mode
    vscodeMock.__state.fireConfigChange({ compactDisplay: true });
    assert.equal(bar.text, '$(pulse) 42,3K (%8)');
    vscodeMock.__state.fireConfigChange({ compactDisplay: false });

    // Transition to WARN (~60.5% = 310,000 / 512,000)
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 10000,
        cache_read_tokens: 300000,
        output_tokens: 500,
        model: 'gemini-4-neon-high',
      }) + '\n'
    );
    await vscodeMock.commands.executeCommand('tokenSayar.refresh');
    assert.equal(bar.text, '$(warning) 310K / 512K (%61)');
    assert.equal(bar.backgroundColor.id, 'statusBarItem.warningBackground');
    assert.ok(bar.tooltip.value.includes('(%60,5), Dolmaya başladı'));

    // Transition to DANGER (~85.5% = 438,000 / 512,000)
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 8000,
        cache_read_tokens: 430000,
        output_tokens: 900,
        model: 'gemini-4-neon-high',
      }) + '\n'
    );
    await vscodeMock.commands.executeCommand('tokenSayar.refresh');
    assert.equal(bar.text, '$(flame) 438K / 512K (%86)');
    assert.equal(bar.backgroundColor.id, 'statusBarItem.errorBackground');
    assert.ok(bar.tooltip.value.includes('(%85,5), Dolu, sıkıştırma önerilir'));

    // Copy summary via openMenu
    vscodeMock.__state.setQuickPickHandler(async (items) => items.find((i) => i.action === 'copy'));
    await vscodeMock.commands.executeCommand('tokenSayar.openMenu');
    assert.ok(vscodeMock.__state.getClipboard().includes('Token Sayar (Antigravity)'));
    assert.ok(vscodeMock.__state.getClipboard().includes('438'));

    // selectConversation QuickPick inspects a conversation in views without hijacking status bar
    let capturedSelectItems = null;
    vscodeMock.__state.setQuickPickHandler(async (items) => {
      capturedSelectItems = items;
      return items.find((i) => i.id === conv2Id);
    });
    await vscodeMock.commands.executeCommand('tokenSayar.selectConversation');
    assert.ok(capturedSelectItems && capturedSelectItems.length >= 4);
    assert.equal(capturedSelectItems[0].isFollowActive, true);
    assert.ok(capturedSelectItems.some((i) => i.kind === vscodeMock.QuickPickItemKind.Separator));
    assert.equal(vscodeMock.__state.contextKeys.get('tokenSayar.inspecting'), true);
    assert.equal(bar.text, '$(flame) 438K / 512K (%86)', 'Inspecting via selectConversation must not change status bar');

    // followActive clears inspecting state
    await vscodeMock.commands.executeCommand('tokenSayar.followActive');
    assert.equal(vscodeMock.__state.contextKeys.get('tokenSayar.inspecting'), false);

    // Pin & unpin status bar via commands
    await vscodeMock.commands.executeCommand('tokenSayar.pinToStatusBar', convId);
    assert.equal(bar.text, '$(flame) 438K / 512K (%86) $(pin)');

    await vscodeMock.commands.executeCommand('tokenSayar.pinToStatusBar', conv2Id);
    assert.equal(bar.text, '$(pulse) Token: — $(pin)');
    assert.equal(bar.backgroundColor, undefined);

    await vscodeMock.commands.executeCommand('tokenSayar.unpinStatusBar');
    assert.equal(bar.text, '$(flame) 438K / 512K (%86)');

    // Pause / resume + instant toggle OFF/ON updates tokenSayar.enabled context key
    await vscodeMock.commands.executeCommand('tokenSayar.pause');
    assert.equal(vscodeMock.__state.configState.enabled, false);
    assert.equal(vscodeMock.__state.contextKeys.get('tokenSayar.enabled'), false);
    assert.equal(bar.text, '$(circle-slash) Token: Kapalı');
    assert.equal(bar.backgroundColor, undefined);
    assert.ok(bar.tooltip.value.includes('Takip duraklatıldı.'));
    assert.ok(bar.tooltip.value.includes('Açmak için tıklayın.'));

    await vscodeMock.commands.executeCommand('tokenSayar.resume');
    assert.equal(vscodeMock.__state.configState.enabled, true);
    assert.equal(vscodeMock.__state.contextKeys.get('tokenSayar.enabled'), true);
    assert.equal(bar.text, '$(flame) 438K / 512K (%86)');
    assert.equal(bar.backgroundColor.id, 'statusBarItem.errorBackground');

    await vscodeMock.commands.executeCommand('tokenSayar.toggle');
    assert.equal(vscodeMock.__state.configState.enabled, false);
    assert.equal(vscodeMock.__state.contextKeys.get('tokenSayar.enabled'), false);

    await vscodeMock.commands.executeCommand('tokenSayar.toggle');
    assert.equal(vscodeMock.__state.configState.enabled, true);
    assert.equal(vscodeMock.__state.contextKeys.get('tokenSayar.enabled'), true);

    // Deactivate & dispose subscriptions cleanly
    loaded.ext.deactivate();
    for (const sub of context.subscriptions) {
      if (sub && typeof sub.dispose === 'function') {
        sub.dispose();
      }
    }
    assert.equal(bar.disposed, true);
  } finally {
    try {
      loaded.ext.deactivate();
    } catch {
      // ignore
    }
    loaded.restore();
    rmDirSafe(tmpDir);
  }
});

test('extension integration: starting with enabled=false renders paused bar without activating watchers', () => {
  const tmpDir = makeTempDir('token-sayar-off-');
  const fakeHome = path.join(tmpDir, 'home');
  const vscodeMock = createMockVscode({ enabled: false }, []);
  const loaded = loadExtensionWithMocks(vscodeMock, fakeHome);
  const context = {
    storageUri: null,
    globalStorageUri: null,
    subscriptions: [],
  };

  try {
    loaded.ext.activate(context);
    const bar = vscodeMock.__state.statusBarItems[0];
    assert.equal(bar.text, '$(circle-slash) Token: Kapalı');
    assert.equal(bar.backgroundColor, undefined);
    assert.equal(bar.visible, true);

    loaded.ext.deactivate();
    for (const sub of context.subscriptions) {
      if (sub && typeof sub.dispose === 'function') {
        sub.dispose();
      }
    }
  } finally {
    loaded.restore();
    rmDirSafe(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 7. Efficiency Status Tiers (All 6 Tiers + Custom Thresholds)
// ---------------------------------------------------------------------------

test('tracker: getEfficiencyStatus covers all 6 tiers and respects custom warnPercent/dangerPercent', () => {
  // none
  assert.equal(getEfficiencyStatus(null, 'ok').tier, 'none');
  assert.equal(getEfficiencyStatus(undefined, 'ok').tier, 'none');
  assert.equal(getEfficiencyStatus(NaN, 'ok').tier, 'none');
  assert.equal(getEfficiencyStatus(20, 'none').tier, 'none');
  assert.equal(getEfficiencyStatus(null, 'none').color, 'muted');

  // default thresholds (warn=55, danger=80, critical=92)
  assert.equal(getEfficiencyStatus(0, 'ok').tier, 'excellent');
  assert.equal(getEfficiencyStatus(34.9, 'ok').tier, 'excellent');
  assert.equal(getEfficiencyStatus(34.9, 'ok').color, 'green');

  assert.equal(getEfficiencyStatus(35, 'ok').tier, 'good');
  assert.equal(getEfficiencyStatus(54.9, 'ok').tier, 'good');
  assert.equal(getEfficiencyStatus(50, 'ok').color, 'green');

  assert.equal(getEfficiencyStatus(55, 'warn').tier, 'degrading');
  assert.equal(getEfficiencyStatus(79.9, 'warn').tier, 'degrading');
  assert.equal(getEfficiencyStatus(65, 'warn').color, 'yellow');

  assert.equal(getEfficiencyStatus(80, 'danger').tier, 'low');
  assert.equal(getEfficiencyStatus(91.9, 'danger').tier, 'low');
  assert.equal(getEfficiencyStatus(85, 'danger').color, 'orange');

  assert.equal(getEfficiencyStatus(92, 'danger').tier, 'critical');
  assert.equal(getEfficiencyStatus(100, 'danger').tier, 'critical');
  assert.equal(getEfficiencyStatus(95, 'danger').color, 'red');

  // custom thresholds
  const customTight = { warnPercent: 30, dangerPercent: 60 };
  assert.equal(getEfficiencyStatus(25, 'ok', customTight).tier, 'excellent');
  assert.equal(getEfficiencyStatus(30, 'warn', customTight).tier, 'degrading');
  assert.equal(getEfficiencyStatus(60, 'danger', customTight).tier, 'low');
  assert.equal(getEfficiencyStatus(92, 'danger', customTight).tier, 'critical');

  const customHighDanger = { warnPercent: 70, dangerPercent: 95 };
  assert.equal(getEfficiencyStatus(93, 'warn', customHighDanger).tier, 'degrading');
  assert.equal(getEfficiencyStatus(95, 'danger', customHighDanger).tier, 'critical');
});

// ---------------------------------------------------------------------------
// 8. listConversations({ includeTokens: true }) Tail-Read & Caching
// ---------------------------------------------------------------------------

test('tracker: listConversations({ includeTokens: true }) handles >64KB tail reads, 256KB fallback, cache hit/invalidation, and isActiveAuto', () => {
  const tmpDir = makeTempDir('token-sayar-tail-');
  try {
    const agyDir = path.join(tmpDir, 'antigravity');
    const wsStateDb = path.join(tmpDir, 'wsStorage', 'state.vscdb');
    fs.mkdirSync(agyDir, { recursive: true });

    const nowSec = Math.floor(Date.now() / 1000);
    const activeId = 'conv-active-tail';
    const bigTailId = 'conv-over-64k';
    const deepFallbackId = 'conv-256k-fallback';

    fs.writeFileSync(
      path.join(agyDir, 'agyhub_summaries_proto.pb'),
      Buffer.concat([
        buildSummaryEntry({ id: activeId, title: 'Active Chat', status: 2, lastModifiedSec: nowSec }),
        buildSummaryEntry({ id: bigTailId, title: 'Large Tail Chat', status: 1, lastModifiedSec: nowSec - 10 }),
        buildSummaryEntry({ id: deepFallbackId, title: 'Deep Fallback Chat', status: 1, lastModifiedSec: nowSec - 20 }),
      ])
    );
    createStateDb(wsStateDb, { lastConversationId: activeId });

    // Active small transcript
    writeTranscript(
      agyDir,
      activeId,
      JSON.stringify({ input_tokens: 12000, cache_read_tokens: 38000, output_tokens: 200, model: 'gemini-4-neon-high' }) + '\n'
    );

    // >75 KB transcript with latest usage line at the end (found inside 64 KB tail)
    const padLine = JSON.stringify({ type: 'LOG', pad: 'x'.repeat(2000) }) + '\n';
    const bigTailPath = writeTranscript(
      agyDir,
      bigTailId,
      padLine.repeat(40) +
        JSON.stringify({ input_tokens: 10000, cache_read_tokens: 190000, output_tokens: 400, model: 'gemini-3-flash' }) +
        '\n'
    );
    assert.ok(fs.statSync(bigTailPath).size > 64 * 1024, 'Fixture should exceed 64 KB');

    // >90 KB transcript where usage line is BEFORE >72 KB of trailing non-usage log lines -> requires 256 KB fallback!
    const deepPath = writeTranscript(
      agyDir,
      deepFallbackId,
      JSON.stringify({ input_tokens: 5000, cache_read_tokens: 155000, output_tokens: 300, model: 'claude-3.7-sonnet' }) +
        '\n' +
        padLine.repeat(40)
    );
    assert.ok(fs.statSync(deepPath).size > 75 * 1024, 'Fallback fixture should push usage beyond last 64 KB');

    const tracker = new TokenTracker({
      antigravityDir: agyDir,
      workspaceStateDbPath: wsStateDb,
      config: { enabled: true },
    });

    // Backwards-compatible default call (includeTokens omitted)
    const plainList = tracker.listConversations(10);
    assert.equal(plainList.length, 3);
    assert.equal('isActiveAuto' in plainList[0], false);
    assert.equal('contextTokens' in plainList[0], false);

    // Enriched list call
    const list1 = tracker.listConversations(10, { includeTokens: true });
    const activeItem = list1.find((c) => c.id === activeId);
    const bigItem = list1.find((c) => c.id === bigTailId);
    const deepItem = list1.find((c) => c.id === deepFallbackId);

    assert.equal(activeItem.isActiveAuto, true);
    assert.equal(activeItem.contextTokens, 50000);
    assert.equal(activeItem.contextLimit, 512000);
    assert.equal(activeItem.bloatLevel, 'ok');

    assert.equal(bigItem.isActiveAuto, false);
    assert.equal(bigItem.contextTokens, 200000);
    assert.equal(bigItem.contextLimit, 256000);
    assert.equal(bigItem.bloatLevel, 'warn');

    assert.equal(deepItem.isActiveAuto, false);
    assert.equal(deepItem.contextTokens, 160000);
    assert.equal(deepItem.contextLimit, 200000);
    assert.equal(deepItem.percent, 80);
    assert.equal(deepItem.bloatLevel, 'danger');

    // Cache hit check: same cached object reference on second call
    const cachedEntryBefore = tracker._tailPreviewCache.get(bigTailId);
    assert.ok(cachedEntryBefore, 'Expected tail preview cache entry');
    const list2 = tracker.listConversations(10, { includeTokens: true });
    assert.strictEqual(tracker._tailPreviewCache.get(bigTailId), cachedEntryBefore, 'Expected cache hit');
    assert.equal(list2.find((c) => c.id === bigTailId).contextTokens, 200000);

    // Append new usage line -> invalidates cache by (size, mtimeMs)
    fs.appendFileSync(
      bigTailPath,
      JSON.stringify({ input_tokens: 15000, cache_read_tokens: 215000, output_tokens: 500, model: 'gemini-3-flash' }) + '\n'
    );
    const list3 = tracker.listConversations(10, { includeTokens: true });
    assert.notStrictEqual(tracker._tailPreviewCache.get(bigTailId), cachedEntryBefore, 'Cache should invalidate on append');
    assert.equal(list3.find((c) => c.id === bigTailId).contextTokens, 230000);
    assert.equal(list3.find((c) => c.id === bigTailId).bloatLevel, 'danger');

    tracker.dispose();
  } finally {
    rmDirSafe(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 9. inspectConversation(id) Isolation & Edge Cases
// ---------------------------------------------------------------------------

test('tracker: inspectConversation(id) inspects another chat without mutating live state or firing onUpdate', () => {
  const tmpDir = makeTempDir('token-sayar-inspect-');
  try {
    const agyDir = path.join(tmpDir, 'antigravity');
    const wsStateDb = path.join(tmpDir, 'wsStorage', 'state.vscdb');
    fs.mkdirSync(agyDir, { recursive: true });

    const convA = 'conv-live-a';
    const convB = 'conv-other-b';
    const nowSec = Math.floor(Date.now() / 1000);

    fs.writeFileSync(
      path.join(agyDir, 'agyhub_summaries_proto.pb'),
      Buffer.concat([
        buildSummaryEntry({ id: convA, title: 'Live Chat A', status: 2, lastModifiedSec: nowSec }),
        buildSummaryEntry({ id: convB, title: 'Other Chat B', status: 1, lastModifiedSec: nowSec - 50 }),
      ])
    );
    createStateDb(wsStateDb, { lastConversationId: convA });
    createConversationDb(path.join(agyDir, 'conversations', `${convB}.db`), {
      contextBudget: 256000,
      modelDisplayName: 'Gemini 4 Hydrogen (Low)',
    });

    writeTranscript(
      agyDir,
      convA,
      JSON.stringify({ input_tokens: 5000, cache_read_tokens: 20000, output_tokens: 100, model: 'gemini-4-neon-high' }) + '\n'
    );
    writeTranscript(
      agyDir,
      convB,
      JSON.stringify({ type: 'CHECKPOINT', input_tokens: 4000, cache_read_tokens: 240000, output_tokens: 800, model: 'gemini-4-hydrogen-low' }) +
        '\n' +
        JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 18000, cache_read_tokens: 142000, output_tokens: 300, model: 'gemini-4-hydrogen-low' }) +
        '\n'
    );

    const updates = [];
    const tracker = new TokenTracker({
      antigravityDir: agyDir,
      workspaceStateDbPath: wsStateDb,
      config: { enabled: true },
      onUpdate: (s) => updates.push(s),
    });

    tracker.start();
    const liveSnapBefore = tracker.getSnapshot();
    const updatesBefore = updates.length;
    assert.equal(liveSnapBefore.conversationId, convA);
    assert.equal(liveSnapBefore.contextTokens, 25000);

    // Inspect convB
    const inspectedB = tracker.inspectConversation(convB);
    assert.equal(inspectedB.conversationId, convB);
    assert.equal(inspectedB.title, 'Other Chat B');
    assert.equal(inspectedB.contextTokens, 160000);
    assert.equal(inspectedB.contextLimit, 256000);
    assert.equal(inspectedB.contextLimitSource, 'db');
    assert.equal(inspectedB.modelDisplayName, 'Gemini 4 Hydrogen (Low)');
    assert.equal(inspectedB.compactionCount, 1);
    assert.equal(inspectedB.turnCount, 2);
    assert.equal(inspectedB.bloatLevel, 'warn');

    // Live state and onUpdate MUST remain untouched
    assert.deepEqual(tracker.getSnapshot(), liveSnapBefore);
    assert.equal(tracker._transcript.conversationId, convA);
    assert.equal(updates.length, updatesBefore, 'inspectConversation must not emit onUpdate');

    // Inspect active convA directly returns live snapshot
    const inspectedA = tracker.inspectConversation(convA);
    assert.equal(inspectedA.conversationId, convA);
    assert.equal(inspectedA.contextTokens, 25000);

    // Missing / empty conversation IDs handled safely
    const missingSnap = tracker.inspectConversation('nonexistent-uuid');
    assert.equal(missingSnap.conversationId, 'nonexistent-uuid');
    assert.equal(missingSnap.hasTranscript, false);
    assert.equal(missingSnap.bloatLevel, 'none');

    const emptySnap = tracker.inspectConversation('');
    assert.equal(emptySnap.conversationId, null);
    assert.equal(emptySnap.bloatLevel, 'none');
    assert.equal(updates.length, updatesBefore);

    tracker.dispose();
  } finally {
    rmDirSafe(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 10. v1.4.0: Native TreeViews (2 Views: Bağlam & Mesaj Akışı)
// ---------------------------------------------------------------------------

test('views v1.4.0: Bağlam clickable Sohbet switcher, conditional Aktif sohbete dön, threshold bar, Durum icons, Kalan (~N mesaj), Tur ve sıkıştırma, Önbellek tasarruf oranı, and 2-view registry', async () => {
  const tmpDir = makeTempDir('token-sayar-views-ctx-');
  const fakeHome = path.join(tmpDir, 'home');
  const agyDir = path.join(fakeHome, '.gemini', 'antigravity');
  const wsDir = path.join(tmpDir, 'ws-views-ctx');
  const wsStorageExtDir = path.join(tmpDir, 'wsStorage', 'local.token-sayar');
  const wsStateDb = path.join(tmpDir, 'wsStorage', 'state.vscdb');
  const globalStorageExtDir = path.join(tmpDir, 'globalStorage', 'local.token-sayar');

  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(wsStorageExtDir, { recursive: true });
  fs.mkdirSync(globalStorageExtDir, { recursive: true });
  fs.mkdirSync(path.join(agyDir, 'annotations'), { recursive: true });

  const conv1 = '11111111-aaaa-bbbb-cccc-111111111111';
  const conv2 = '22222222-aaaa-bbbb-cccc-222222222222';
  const longTitle = 'Çok Uzun Bir Sohbet Başlığı Kırpılma Testi İçin Elli Karakterden Fazla';
  const nowSec = Math.floor(Date.now() / 1000);
  const wsUri = 'file:///' + wsDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}%3A`);

  fs.writeFileSync(
    path.join(agyDir, 'agyhub_summaries_proto.pb'),
    Buffer.concat([
      buildSummaryEntry({
        id: conv1,
        title: longTitle,
        stepCount: 10,
        lastModifiedSec: nowSec,
        status: 2,
        workspaceUri: wsUri,
      }),
      buildSummaryEntry({
        id: conv2,
        title: 'İkinci İncelenen Sohbet',
        stepCount: 20,
        lastModifiedSec: nowSec - 30,
        status: 1,
        workspaceUri: wsUri,
      }),
    ])
  );
  createStateDb(wsStateDb, { lastConversationId: conv1 });
  // conv1: 75,100 / 280,000 = 26.821% -> %26,8 (below warnPercent 55 -> no badge), multi-model
  createConversationDb(path.join(agyDir, 'conversations', `${conv1}.db`), {
    contextBudget: 280000,
    modelDisplayName: 'Gemini 4 Neon (High)',
  });
  const db1 = new DatabaseSync(path.join(agyDir, 'conversations', `${conv1}.db`));
  try {
    db1.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(2, buildGenMetadata('Claude Sonnet 4.5'));
  } finally {
    db1.close();
  }
  writeTranscript(
    agyDir,
    conv1,
    [
      JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Merhaba' }),
      JSON.stringify({ type: 'CHECKPOINT', created_at: '2026-11-23T05:00:00Z' }),
      JSON.stringify({ input_tokens: 5100, cache_read_tokens: 70000, output_tokens: 400, model: 'gemini-4-neon-high', created_at: '2026-11-23T05:05:00Z' }),
    ].join('\n') + '\n'
  );

  // conv2: 200,000 / 256,000 = 78.125% -> %78,1 (above warnPercent 55 -> badge = 78)
  createConversationDb(path.join(agyDir, 'conversations', `${conv2}.db`), {
    contextBudget: 256000,
    modelDisplayName: 'Gemini 4 Hydrogen (Low)',
  });
  writeTranscript(
    agyDir,
    conv2,
    JSON.stringify({ input_tokens: 20000, cache_read_tokens: 180000, output_tokens: 600, model: 'gemini-4-hydrogen-low' }) + '\n'
  );

  const vscodeMock = createMockVscode({ enabled: true, warnPercent: 55, dangerPercent: 80 }, [wsDir]);
  const loaded = loadExtensionWithMocks(vscodeMock, fakeHome);
  const context = {
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    storageUri: { fsPath: wsStorageExtDir },
    globalStorageUri: { fsPath: globalStorageExtDir },
    subscriptions: [],
  };

  try {
    loaded.ext.activate(context);

    // Exactly 2 TreeViews (context + timeline); no tokenSayar.conversations
    assert.deepEqual(Object.keys(VIEW_IDS), ['context', 'timeline']);
    assert.deepEqual([...vscodeMock.__state.treeViews.keys()], ['tokenSayar.context', 'tokenSayar.timeline']);
    assert.equal(vscodeMock.__state.treeViews.has('tokenSayar.conversations'), false);

    const ctxEntry = vscodeMock.__state.treeViews.get('tokenSayar.context');
    assert.ok(ctxEntry, 'Expected tokenSayar.context TreeView');

    const rootItems = vscodeMock.__state.getTreeViewChildren('tokenSayar.context');
    assert.deepEqual(
      rootItems.map((i) => i.label),
      ['Sohbet', 'Doluluk', 'Durum', 'Kalan', 'Model', 'Tur ve sıkıştırma', 'Ayrıntılar']
    );

    // Root 1: Clickable Sohbet switcher
    assert.equal(rootItems[0].command.command, 'tokenSayar.selectConversation');
    assert.ok(rootItems[0].description.endsWith(' · Değiştir'));
    assert.equal(rootItems[0].description.includes('(İnceleniyor)'), false);

    // Doluluk: 20-cell threshold bar + Turkish comma decimals + threshold tooltip
    const expectedBar1 = buildThresholdBar(26.8, 55, 80);
    assert.equal(rootItems[1].description, `${expectedBar1}  75,1K / 280K (%26,8)`);
    assert.ok(rootItems[1].tooltip.value.includes('Sarı eşik: %55 (154K)'));
    assert.ok(rootItems[1].tooltip.value.includes('kırmızı eşik: %80 (224K)'));

    // Durum: pulse icon when ok
    assert.equal(rootItems[2].description, 'Sağlıklı');
    assert.equal(rootItems[2].iconPath.id, 'pulse');

    // Kalan: includes ~N mesaj when estimatedRemainingMessages is available
    assert.equal(rootItems[3].description, '205K (~2 mesaj)');

    // Model: multi-model collapsible
    assert.equal(rootItems[4].description, '2 model, son: Claude Sonnet 4.5');
    assert.equal(rootItems[4].collapsibleState, vscodeMock.TreeItemCollapsibleState.Collapsed);

    // Tur ve sıkıştırma combined
    assert.equal(rootItems[5].description, '1 tur · 1 sıkıştırma');

    // Badge is undefined below warnPercent (26.8 < 55)
    assert.equal(ctxEntry.view.badge, undefined);
    // Description is truncated to max 40 chars
    assert.ok(ctxEntry.view.description && ctxEntry.view.description.length <= 40);
    assert.ok(ctxEntry.view.description.endsWith('…'));
    // Message is undefined when tracking active chat
    assert.equal(ctxEntry.view.message, undefined);

    // Multi-model children
    const modelChildren = vscodeMock.__state.getTreeViewChildren('tokenSayar.context', rootItems[4]);
    assert.deepEqual(
      modelChildren.map((c) => c.label),
      ['Gemini 4 Neon (High)', 'Claude Sonnet 4.5']
    );

    // Ayrıntılar children (includes Önbellek tasarruf oranı)
    assert.equal(rootItems[6].collapsibleState, vscodeMock.TreeItemCollapsibleState.Collapsed);
    const detailChildren = vscodeMock.__state.getTreeViewChildren('tokenSayar.context', rootItems[6]);
    assert.deepEqual(
      detailChildren.map((c) => c.label),
      [
        'Son adım yeni girdi',
        'Son adım önbellekten okunan',
        'Son adım çıktısı',
        'Oturum toplamı işlenen',
        'Oturum toplam çıktı',
        'Önbellek tasarruf oranı',
        'Limit kaynağı',
        'Son güncelleme',
      ]
    );
    assert.equal(detailChildren[0].description, '5,1K');
    assert.equal(detailChildren[1].description, '70K');
    assert.equal(detailChildren[5].description, '%93,2');
    assert.equal(detailChildren[6].description, 'Antigravity sohbet verisi');

    // Inspecting non-active chat (78.1% >= 55%): shows conditional 'Aktif sohbete dön' row, '(İnceleniyor) · Değiştir', warning icon, message AND badge
    await vscodeMock.commands.executeCommand('tokenSayar.inspectConversation', conv2);
    const inspectedItems = vscodeMock.__state.getTreeViewChildren('tokenSayar.context');
    assert.deepEqual(
      inspectedItems.map((i) => i.label),
      ['Sohbet', 'Aktif sohbete dön', 'Doluluk', 'Durum', 'Kalan', 'Model', 'Tur ve sıkıştırma', 'Ayrıntılar']
    );
    assert.equal(inspectedItems[0].description, 'İkinci İncelenen Sohbet (İnceleniyor) · Değiştir');
    assert.equal(inspectedItems[1].command.command, 'tokenSayar.followActive');
    assert.equal(inspectedItems[2].description, `${buildThresholdBar(78.1, 55, 80)}  200K / 256K (%78,1)`);
    assert.equal(inspectedItems[3].iconPath.id, 'warning');
    assert.equal(inspectedItems[4].description, '56K');
    assert.equal(ctxEntry.view.message, 'Aktif olmayan bir sohbet gösteriliyor.');
    assert.deepEqual(ctxEntry.view.badge, { value: 78, tooltip: 'Bağlam %78 dolu' });

    // Disabled state returns [] and clears description/message/badge
    await vscodeMock.commands.executeCommand('tokenSayar.pause');
    const disabledItems = vscodeMock.__state.getTreeViewChildren('tokenSayar.context');
    assert.deepEqual(disabledItems, []);
    assert.equal(ctxEntry.view.description, undefined);
    assert.equal(ctxEntry.view.message, undefined);
    assert.equal(ctxEntry.view.badge, undefined);

    loaded.ext.deactivate();
    for (const sub of context.subscriptions) {
      if (sub && typeof sub.dispose === 'function') {
        sub.dispose();
      }
    }
  } finally {
    try {
      loaded.ext.deactivate();
    } catch {
      // ignore
    }
    loaded.restore();
    rmDirSafe(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 11. v1.1.0: Multi-model modelsUsed & Dynamic DB Cache Invalidation
// ---------------------------------------------------------------------------

test('tracker v1.1.0: modelsUsed tracking, deduplication, and dynamic DB cache invalidation on turnCount or mtimeMs change', () => {
  const tmpDir = makeTempDir('token-sayar-v11-db-');
  try {
    const agyDir = path.join(tmpDir, 'antigravity');
    const convId = 'conv-v11-multimodel';
    const dbPath = path.join(agyDir, 'conversations', `${convId}.db`);

    // Initial DB: idx 1 -> 512K, Gemini 4 Neon (High)
    createConversationDb(dbPath, {
      contextBudget: 512000,
      modelDisplayName: 'Gemini 4 Neon (High)',
    });

    const transcriptPath = writeTranscript(
      agyDir,
      convId,
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 10000,
        cache_read_tokens: 30000,
        output_tokens: 200,
        model: 'gemini-4-neon-high',
      }) + '\n'
    );

    const tracker = new TokenTracker({
      antigravityDir: agyDir,
      config: { enabled: true },
    });

    // Empty snapshot must expose modelsUsed: []
    assert.deepEqual(tracker.getSnapshot().modelsUsed, []);

    tracker.setPinnedConversation(convId);
    let snap = tracker.refresh();
    assert.equal(snap.contextLimit, 512000);
    assert.equal(snap.contextLimitSource, 'db');
    assert.equal(snap.modelDisplayName, 'Gemini 4 Neon (High)');
    assert.deepEqual(snap.modelsUsed, ['Gemini 4 Neon (High)']);

    // 1) Mid-chat model switch in DB with SAME turnCount, but bumped mtimeMs -> must invalidate cache!
    const prevStat = fs.statSync(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(2, buildExecutorMetadata(256000));
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
        2,
        buildGenMetadata('Gemini 3.8 Flash (Medium)')
      );
      // Duplicate of first model at idx 3 should not duplicate in modelsUsed
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
        3,
        buildGenMetadata('Gemini 4 Neon (High)')
      );
    } finally {
      db.close();
    }
    const bumpedTime = new Date(prevStat.mtimeMs + 3000);
    fs.utimesSync(dbPath, bumpedTime, bumpedTime);

    snap = tracker.refresh();
    assert.equal(snap.contextLimit, 256000, 'mtimeMs change must re-query latest executor_metadata');
    assert.deepEqual(snap.modelsUsed, ['Gemini 4 Neon (High)', 'Gemini 3.8 Flash (Medium)']);

    // 2) New turnCount in transcript with DB updated AND mtimeMs kept identical -> turnCount increase must re-query!
    const statBeforeTurn = fs.statSync(dbPath);
    const db2 = new DatabaseSync(dbPath);
    try {
      db2.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(3, buildExecutorMetadata(160000));
      db2.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
        4,
        buildGenMetadata('Claude Sonnet 4.6 (Thinking)')
      );
    } finally {
      db2.close();
    }
    // Force mtime back to statBeforeTurn to prove turnCount > checkedTurnCount triggers re-query on its own
    fs.utimesSync(dbPath, statBeforeTurn.atime, statBeforeTurn.mtime);

    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 15000,
        cache_read_tokens: 65000,
        output_tokens: 400,
        model: 'claude-sonnet-4-6-thinking',
      }) + '\n'
    );

    snap = tracker.refresh();
    assert.equal(snap.turnCount, 2);
    assert.equal(snap.contextLimit, 160000, 'turnCount increase must re-query DB even with same mtimeMs');
    assert.equal(snap.modelDisplayName, 'Claude Sonnet 4.6 (Thinking)');
    assert.deepEqual(snap.modelsUsed, [
      'Gemini 4 Neon (High)',
      'Gemini 3.8 Flash (Medium)',
      'Claude Sonnet 4.6 (Thinking)',
    ]);

    tracker.dispose();
  } finally {
    rmDirSafe(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 12. v1.4.0: Mesaj Akışı (5 Chronological Steps) & 2-View Commands
// ---------------------------------------------------------------------------

test('views v1.4.0: Mesaj Akışı strict lazy loading, 5 chronological steps, step progress children, flame highlight, fold compaction delta, and MarkdownString safety', async () => {
  const tmpDir = makeTempDir('token-sayar-views-tl-');
  const fakeHome = path.join(tmpDir, 'home');
  const agyDir = path.join(fakeHome, '.gemini', 'antigravity');
  const wsDir = path.join(tmpDir, 'ws-views-tl');
  const wsStorageExtDir = path.join(tmpDir, 'wsStorage', 'local.token-sayar');
  const wsStateDb = path.join(tmpDir, 'wsStorage', 'state.vscdb');
  const globalStorageExtDir = path.join(tmpDir, 'globalStorage', 'local.token-sayar');

  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(wsStorageExtDir, { recursive: true });
  fs.mkdirSync(globalStorageExtDir, { recursive: true });
  fs.mkdirSync(path.join(agyDir, 'annotations'), { recursive: true });

  const convId = '33333333-4444-5555-6666-777777777777';
  const nowSec = Math.floor(Date.now() / 1000);
  const wsUri = 'file:///' + wsDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}%3A`);

  fs.writeFileSync(
    path.join(agyDir, 'agyhub_summaries_proto.pb'),
    buildSummaryEntry({
      id: convId,
      title: 'Mesaj Akışı Testi',
      stepCount: 5,
      lastModifiedSec: nowSec,
      status: 2,
      workspaceUri: wsUri,
    })
  );
  createStateDb(wsStateDb, { lastConversationId: convId });
  createConversationDb(path.join(agyDir, 'conversations', `${convId}.db`), {
    contextBudget: 256000,
    modelDisplayName: 'Gemini 4 Neon (High)',
  });
  writeTranscript(
    agyDir,
    convId,
    [
      // Pre-user turn -> Başlangıç
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 1000,
        cache_read_tokens: 2000,
        output_tokens: 100,
        model: 'gemini-4-neon-high',
        created_at: '2026-11-23T06:00:00Z',
      }),
      JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content: '<script>alert("xss")</script> İlk soru',
        created_at: '2026-11-23T06:01:00Z',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 10000,
        cache_read_tokens: 30000,
        output_tokens: 500,
        model: 'gemini-4-neon-high',
        created_at: '2026-11-23T06:01:10Z',
      }),
      JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content: '[link](command:evil) İkinci soru',
        created_at: '2026-11-23T06:02:00Z',
      }),
      JSON.stringify({
        type: 'CHECKPOINT',
        created_at: '2026-11-23T06:02:02Z',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 5000,
        cache_read_tokens: 10000,
        output_tokens: 300,
        model: 'gemini-4-neon-high',
        created_at: '2026-11-23T06:02:10Z',
      }),
    ].join('\n') + '\n'
  );

  // Spy on TokenTracker.prototype.getMessageTimeline
  let timelineCalls = 0;
  const origGetTimeline = TokenTracker.prototype.getMessageTimeline;
  TokenTracker.prototype.getMessageTimeline = function spiedGetTimeline(id) {
    timelineCalls += 1;
    return origGetTimeline.call(this, id);
  };

  const vscodeMock = createMockVscode({ enabled: true }, [wsDir]);
  const loaded = loadExtensionWithMocks(vscodeMock, fakeHome);
  const context = {
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    storageUri: { fsPath: wsStorageExtDir },
    globalStorageUri: { fsPath: globalStorageExtDir },
    subscriptions: [],
  };

  try {
    loaded.ext.activate(context);

    const tlEntry = vscodeMock.__state.treeViews.get('tokenSayar.timeline');
    assert.ok(tlEntry, 'Expected tokenSayar.timeline TreeView');
    assert.equal(tlEntry.view.visible, false);

    // Strict lazy loading: invisible -> getChildren() returns [] and NEVER calls getMessageTimeline
    assert.deepEqual(vscodeMock.__state.getTreeViewChildren('tokenSayar.timeline'), []);
    await vscodeMock.commands.executeCommand('tokenSayar.refresh');
    assert.equal(timelineCalls, 0, 'getMessageTimeline must NOT be called while timeline view is invisible');

    // Make visible -> fires onDidChangeTreeData, then getChildren calls getMessageTimeline once
    let treeChangeEvents = 0;
    tlEntry.options.treeDataProvider.onDidChangeTreeData(() => {
      treeChangeEvents += 1;
    });
    vscodeMock.__state.setTreeViewVisible('tokenSayar.timeline', true);
    assert.ok(treeChangeEvents >= 1, 'Becoming visible should fire onDidChangeTreeData');

    const rootTurns = vscodeMock.__state.getTreeViewChildren('tokenSayar.timeline');
    assert.equal(timelineCalls, 1, 'getMessageTimeline MUST be called once timeline view is visible');
    assert.equal(rootTurns.length, 3);

    // Chronological order: Başlangıç, 1. "...", 2. "..."
    assert.equal(rootTurns[0].label, 'Başlangıç');
    assert.equal(rootTurns[0].iconPath.id, 'history');
    assert.equal(rootTurns[0].collapsibleState, vscodeMock.TreeItemCollapsibleState.Collapsed);

    // Turn 1 is the largest non-compacted turn -> highlighted with flame icon (charts.orange)
    assert.ok(rootTurns[1].label.startsWith('1. "'));
    assert.equal(rootTurns[1].collapsibleState, vscodeMock.TreeItemCollapsibleState.Collapsed);
    assert.equal(rootTurns[1].iconPath.id, 'flame');
    assert.equal(rootTurns[1].iconPath.color.id, 'charts.orange');

    // Last turn is Expanded and has fold icon due to CHECKPOINT compaction
    assert.ok(rootTurns[2].label.startsWith('2. "'));
    assert.equal(rootTurns[2].collapsibleState, vscodeMock.TreeItemCollapsibleState.Expanded);
    assert.equal(rootTurns[2].iconPath.id, 'fold');

    // View description summarizes messageCount and totalProcessedTokens
    assert.ok(tlEntry.view.description.includes('2 mesaj,'));

    // MarkdownString prompt safety: isTrusted === false and text appended safely
    assert.ok(rootTurns[1].tooltip instanceof vscodeMock.MarkdownString);
    assert.equal(rootTurns[1].tooltip.isTrusted, false);
    assert.ok(rootTurns[1].tooltip.value.includes('<script>alert("xss")</script> İlk soru'));
    assert.equal(rootTurns[2].tooltip.isTrusted, false);

    // 5 chronological steps per turn
    const turn1Children = vscodeMock.__state.getTreeViewChildren('tokenSayar.timeline', rootTurns[1]);
    assert.deepEqual(
      turn1Children.map((c) => c.label),
      [
        '1. Senin mesajın',
        '2. Modele okutulan bağlam (1 adım)',
        '3. Model düşünmesi (geçici)',
        '4. Model yanıtı ve araç çağrıları',
        '5. Net bağlam değişimi (kalıcı)',
      ]
    );

    // Step 2 has 3 read-traffic children
    assert.equal(turn1Children[1].description, '40K (30K önbellek · 10K yeni)');
    const step2Children = vscodeMock.__state.getTreeViewChildren('tokenSayar.timeline', turn1Children[1]);
    assert.deepEqual(
      step2Children.map((c) => [c.label, c.description]),
      [
        ['Önbellekten tekrar okunan', '30K'],
        ['İlk kez okunan yeni girdi', '10K'],
        ['Adım başına ortalama okunan', '40K'],
      ]
    );

    // Step 3: hasThinkingSplit: false -> '—'
    assert.equal(turn1Children[2].description, '—');
    // Step 4: visible output
    assert.equal(turn1Children[3].description, '500');

    // Step 5: exact arithmetic children + Adım adım bağlam ilerlemesi
    assert.equal(turn1Children[4].description, '3K → 40K (+37K)');
    const step5Children1 = vscodeMock.__state.getTreeViewChildren('tokenSayar.timeline', turn1Children[4]);
    assert.deepEqual(
      step5Children1.map((c) => [c.label, c.description]),
      [
        ['Önceki bağlam', '3K'],
        ['Eklenen kullanıcı mesajı', '+~10'],
        ['Eklenen araç çıktıları ve yanıtlar', '+37K'],
        ['Yeni aktif bağlam', '40K'],
        ['Adım adım bağlam ilerlemesi (1 adım)', undefined],
      ]
    );
    const stepProgress1 = vscodeMock.__state.getTreeViewChildren('tokenSayar.timeline', step5Children1[4]);
    assert.equal(stepProgress1.length, 1);
    assert.equal(stepProgress1[0].label, 'Adım 1');
    assert.ok(stepProgress1[0].description.includes('40K bağlam'));

    // Negative CHECKPOINT compaction delta on turn 2 -> '40K → 15K (Sıkıştırıldı −25K)' + 2 steps in progress
    const turn2Children = vscodeMock.__state.getTreeViewChildren('tokenSayar.timeline', rootTurns[2]);
    const step5Turn2 = turn2Children.find((c) => c.label === '5. Net bağlam değişimi (kalıcı)');
    assert.ok(step5Turn2);
    assert.equal(step5Turn2.description, '40K → 15K (Sıkıştırıldı −25K)');
    const step5Children2 = vscodeMock.__state.getTreeViewChildren('tokenSayar.timeline', step5Turn2);
    assert.equal(step5Children2[1].label, 'Sıkıştırma ile temizlenen');
    assert.equal(step5Children2[1].description, '−25K');
    const progressTurn2 = vscodeMock.__state.getTreeViewChildren('tokenSayar.timeline', step5Children2[3]);
    assert.equal(progressTurn2.length, 2);
    assert.equal(progressTurn2[0].label, 'Adım 1');
    assert.equal(progressTurn2[1].label, 'Adım 2');

    loaded.ext.deactivate();
    for (const sub of context.subscriptions) {
      if (sub && typeof sub.dispose === 'function') {
        sub.dispose();
      }
    }
  } finally {
    TokenTracker.prototype.getMessageTimeline = origGetTimeline;
    try {
      loaded.ext.deactivate();
    } catch {
      // ignore
    }
    loaded.restore();
    rmDirSafe(tmpDir);
  }
});

test('views v1.4.0: 2-view commands, selectConversation QuickPick, followActive, pin/unpin, copyValue, openPanel/openTimeline, and showHelp', async () => {
  const tmpDir = makeTempDir('token-sayar-views-cmds-');
  const fakeHome = path.join(tmpDir, 'home');
  const agyDir = path.join(fakeHome, '.gemini', 'antigravity');
  const wsDir = path.join(tmpDir, 'ws-current');
  const otherWsDir = path.join(tmpDir, 'ws-other');
  const wsStorageExtDir = path.join(tmpDir, 'wsStorage', 'local.token-sayar');
  const wsStateDb = path.join(tmpDir, 'wsStorage', 'state.vscdb');
  const globalStorageExtDir = path.join(tmpDir, 'globalStorage', 'local.token-sayar');

  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(otherWsDir, { recursive: true });
  fs.mkdirSync(wsStorageExtDir, { recursive: true });
  fs.mkdirSync(globalStorageExtDir, { recursive: true });
  fs.mkdirSync(path.join(agyDir, 'annotations'), { recursive: true });

  const convCurrent1 = '44444444-1111-2222-3333-444444444444';
  const convCurrent2 = '44444444-1111-2222-3333-555555555555';
  const convOther = '55555555-6666-7777-8888-999999999999';
  const nowSec = Math.floor(Date.now() / 1000);
  const toUri = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}%3A`);

  fs.writeFileSync(
    path.join(agyDir, 'agyhub_summaries_proto.pb'),
    Buffer.concat([
      buildSummaryEntry({
        id: convOther,
        title: 'Diğer Alan Sohbeti',
        stepCount: 8,
        lastModifiedSec: nowSec,
        status: 1,
        workspaceUri: toUri(otherWsDir),
      }),
      buildSummaryEntry({
        id: convCurrent1,
        title: 'Aktif Alan Sohbet 1',
        stepCount: 6,
        lastModifiedSec: nowSec - 10,
        status: 2,
        workspaceUri: toUri(wsDir),
      }),
      buildSummaryEntry({
        id: convCurrent2,
        title: 'Aktif Alan Sohbet 2',
        stepCount: 3,
        lastModifiedSec: nowSec - 20,
        status: 1,
        workspaceUri: toUri(wsDir),
      }),
    ])
  );
  createStateDb(wsStateDb, { lastConversationId: convCurrent1 });
  writeTranscript(
    agyDir,
    convCurrent1,
    JSON.stringify({ input_tokens: 10000, cache_read_tokens: 20000, output_tokens: 200, model: 'gemini-4-neon-high' }) + '\n'
  );
  writeTranscript(
    agyDir,
    convOther,
    JSON.stringify({ input_tokens: 50000, cache_read_tokens: 100000, output_tokens: 200, model: 'gemini-4-neon-high' }) + '\n'
  );

  const extUri = { fsPath: path.resolve(__dirname, '..') };
  const vscodeMock = createMockVscode({ enabled: true }, [wsDir]);
  const loaded = loadExtensionWithMocks(vscodeMock, fakeHome);
  const context = {
    extensionUri: extUri,
    storageUri: { fsPath: wsStorageExtDir },
    globalStorageUri: { fsPath: globalStorageExtDir },
    subscriptions: [],
  };

  try {
    loaded.ext.activate(context);

    // Confirm only 2 views registered (no tokenSayar.conversations)
    assert.equal(vscodeMock.__state.treeViews.has('tokenSayar.conversations'), false);
    assert.equal(vscodeMock.__state.treeViews.size, 2);

    // Pin convCurrent2 to status bar, then unpin back to auto
    await vscodeMock.commands.executeCommand('tokenSayar.pinToStatusBar', convCurrent2);
    assert.ok(vscodeMock.__state.statusBarItems[0].text.includes('$(pin)'));
    await vscodeMock.commands.executeCommand('tokenSayar.unpinStatusBar');
    assert.equal(vscodeMock.__state.statusBarItems[0].text.includes('$(pin)'), false);

    // Inspect another conversation -> tokenSayar.inspecting = true
    await vscodeMock.commands.executeCommand('tokenSayar.inspectConversation', convOther);
    assert.equal(vscodeMock.__state.contextKeys.get('tokenSayar.inspecting'), true);

    // Clicking active auto conversation clears inspectedId -> tokenSayar.inspecting = false
    await vscodeMock.commands.executeCommand('tokenSayar.inspectConversation', convCurrent1);
    assert.equal(vscodeMock.__state.contextKeys.get('tokenSayar.inspecting'), false);

    // selectConversation QuickPick includes Aktif sohbeti takip et + separators for both workspaces
    let quickPickItems = null;
    vscodeMock.__state.setQuickPickHandler(async (items) => {
      quickPickItems = items;
      return items.find((i) => i.id === convOther);
    });
    await vscodeMock.commands.executeCommand('tokenSayar.selectConversation');
    assert.equal(quickPickItems[0].label, '$(target) Aktif sohbeti takip et');
    assert.ok(quickPickItems.some((i) => i.kind === vscodeMock.QuickPickItemKind.Separator && i.label === 'Bu çalışma alanı'));
    assert.ok(quickPickItems.some((i) => i.kind === vscodeMock.QuickPickItemKind.Separator && i.label === 'Diğer çalışma alanları'));
    assert.equal(vscodeMock.__state.contextKeys.get('tokenSayar.inspecting'), true);

    // followActive returns to active chat
    await vscodeMock.commands.executeCommand('tokenSayar.followActive');
    assert.equal(vscodeMock.__state.contextKeys.get('tokenSayar.inspecting'), false);

    // copyValue copies label: description to clipboard
    const ctxItems = vscodeMock.__state.getTreeViewChildren('tokenSayar.context');
    const dolulukItem = ctxItems.find((i) => i.label === 'Doluluk');
    await vscodeMock.commands.executeCommand('tokenSayar.copyValue', dolulukItem);
    assert.equal(vscodeMock.__state.getClipboard(), `${dolulukItem.label}: ${dolulukItem.description}`);

    // openPanel & openTimeline focus commands
    await vscodeMock.commands.executeCommand('tokenSayar.openPanel');
    await vscodeMock.commands.executeCommand('tokenSayar.openTimeline');
    assert.ok(vscodeMock.__state.executedCommands.some((c) => c.id === 'tokenSayar.context.focus'));
    assert.ok(vscodeMock.__state.executedCommands.some((c) => c.id === 'tokenSayar.timeline.focus'));

    // showHelp calls markdown.showPreview with Uri.joinPath(extensionUri, 'media', 'help.md') and falls back to showTextDocument
    let previewCalled = false;
    vscodeMock.__state.setCommandMock('markdown.showPreview', async (uri) => {
      previewCalled = true;
      assert.equal(uri.fsPath, path.join(extUri.fsPath, 'media', 'help.md'));
    });
    await vscodeMock.commands.executeCommand('tokenSayar.showHelp');
    assert.equal(previewCalled, true);

    vscodeMock.__state.setCommandMock('markdown.showPreview', async () => {
      throw new Error('markdown preview unavailable');
    });
    await vscodeMock.commands.executeCommand('tokenSayar.showHelp');
    assert.equal(vscodeMock.__state.shownTextDocuments.length, 1);
    assert.equal(vscodeMock.__state.shownTextDocuments[0].fsPath, path.join(extUri.fsPath, 'media', 'help.md'));

    loaded.ext.deactivate();
    for (const sub of context.subscriptions) {
      if (sub && typeof sub.dispose === 'function') {
        sub.dispose();
      }
    }
  } finally {
    try {
      loaded.ext.deactivate();
    } catch {
      // ignore
    }
    loaded.restore();
    rmDirSafe(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 13. v1.2.0: parseGenMetadataUsage & getMessageTimeline
// ---------------------------------------------------------------------------

test('proto v1.2.0: parseGenMetadataUsage decodes f2/f3/f5/f9/f10, handles missing f9/f10 fallback, and never throws on truncated/corrupt input', () => {
  const withThinking = buildGenMetadataWithUsage({
    displayName: 'Gemini 4 Neon (High)',
    inputTokens: 12000,
    outputTokens: 2500,
    cacheReadTokens: 48000,
    thinkingTokens: 1800,
    visibleOutputTokens: 700,
  });

  const parsed = proto.parseGenMetadataUsage(withThinking);
  assert.deepEqual(parsed, {
    inputTokens: 12000,
    outputTokens: 2500,
    cacheReadTokens: 48000,
    thinkingTokens: 1800,
    visibleOutputTokens: 700,
    hasThinkingField: true,
  });

  // Fallback when f9/f10 are absent
  const withoutThinking = buildGenMetadataWithUsage({
    inputTokens: 5000,
    outputTokens: 900,
    cacheReadTokens: 15000,
  });
  assert.deepEqual(proto.parseGenMetadataUsage(withoutThinking), {
    inputTokens: 5000,
    outputTokens: 900,
    cacheReadTokens: 15000,
    thinkingTokens: 0,
    visibleOutputTokens: 900,
    hasThinkingField: false,
  });

  // Prefix truncation & corrupt payloads never throw
  for (let len = 0; len <= withThinking.length; len++) {
    assert.doesNotThrow(() => proto.parseGenMetadataUsage(withThinking.subarray(0, len)));
  }
  for (const bad of [null, undefined, Buffer.alloc(0), Buffer.alloc(12, 0xff), Buffer.from([0x0a, 0xff, 0xff, 0x01])]) {
    assert.doesNotThrow(() => proto.parseGenMetadataUsage(bad));
  }
  assert.equal(proto.parseGenMetadataUsage(Buffer.alloc(0)), null);
});

test('tracker v1.2.0: getMessageTimeline groups USER_INPUT turns, keeps SYSTEM_MESSAGE in turn, handles pre-user & compaction, maps gen_metadata thinking split, and caches', () => {
  const tmpDir = makeTempDir('token-sayar-v12-tl-');
  try {
    const agyDir = path.join(tmpDir, 'antigravity');
    const convId = 'conv-v12-timeline';
    const dbPath = path.join(agyDir, 'conversations', `${convId}.db`);

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS executor_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.exec('CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(1, buildExecutorMetadata(512000));
      // 4 PLANNER_RESPONSE ordinals (0..3)
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
        0,
        buildGenMetadataWithUsage({
          displayName: 'Gemini 4 Neon (High)',
          inputTokens: 4000,
          outputTokens: 300,
          cacheReadTokens: 0,
          thinkingTokens: 200,
          visibleOutputTokens: 100,
        })
      );
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
        1,
        buildGenMetadataWithUsage({
          displayName: 'Gemini 4 Neon (High)',
          inputTokens: 20000,
          outputTokens: 1500,
          cacheReadTokens: 10000,
          thinkingTokens: 1000,
          visibleOutputTokens: 500,
        })
      );
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
        2,
        buildGenMetadataWithUsage({
          displayName: 'Gemini 4 Neon (High)',
          inputTokens: 15000,
          outputTokens: 1200,
          cacheReadTokens: 35000,
          thinkingTokens: 800,
          visibleOutputTokens: 400,
        })
      );
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
        3,
        buildGenMetadataWithUsage({
          displayName: 'Gemini 4 Neon (High)',
          inputTokens: 5000,
          outputTokens: 600,
          cacheReadTokens: 15000,
          thinkingTokens: 400,
          visibleOutputTokens: 200,
        })
      );
    } finally {
      db.close();
    }

    const lines = [
      // Pre-user PLANNER_RESPONSE -> ordinal 0, index 0, isPreUser: true
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 4000,
        cache_read_tokens: 0,
        output_tokens: 300,
        model: 'gemini-4-neon-high',
        created_at: '2026-11-23T06:00:00Z',
      }),
      // Mesaj 1 with <USER_REQUEST> wrapper
      JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content: '<USER_REQUEST>\nMerhaba, projeyi analiz et.\n</USER_REQUEST>',
        created_at: '2026-11-23T06:01:00Z',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 20000,
        cache_read_tokens: 10000,
        output_tokens: 1500,
        model: 'gemini-4-neon-high',
        created_at: '2026-11-23T06:01:10Z',
      }),
      // SYSTEM_MESSAGE must stay inside Mesaj 1 (must NOT increment messageCount!)
      JSON.stringify({
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        content: 'The following is a <SYSTEM_MESSAGE> swarm wakeup',
        created_at: '2026-11-23T06:01:20Z',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 15000,
        cache_read_tokens: 35000,
        output_tokens: 1200,
        model: 'gemini-4-neon-high',
        created_at: '2026-11-23T06:01:30Z',
      }),
      // Mesaj 2 with CHECKPOINT compaction -> negative contextDelta!
      JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content: 'Sıkıştır ve devam et',
        created_at: '2026-11-23T06:02:00Z',
      }),
      JSON.stringify({
        type: 'CHECKPOINT',
        created_at: '2026-11-23T06:02:05Z',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 5000,
        cache_read_tokens: 15000,
        output_tokens: 600,
        model: 'gemini-4-neon-high',
        created_at: '2026-11-23T06:02:15Z',
      }),
    ].join('\n') + '\n';

    const transcriptPath = writeTranscript(agyDir, convId, lines);
    const tracker = new TokenTracker({ antigravityDir: agyDir, config: { enabled: true } });

    // Missing / empty conversation IDs handled cleanly
    assert.equal(tracker.getMessageTimeline('').turns.length, 0);
    assert.equal(tracker.getMessageTimeline('nonexistent-conv').turns.length, 0);

    const tl1 = tracker.getMessageTimeline(convId);
    assert.equal(tl1.hasThinkingSplit, true);
    assert.equal(tl1.turns.length, 3); // pre-user + Mesaj 1 + Mesaj 2
    assert.equal(tl1.totals.messageCount, 2);

    // Pre-user turn
    assert.equal(tl1.turns[0].isPreUser, true);
    assert.equal(tl1.turns[0].index, 0);
    assert.equal(tl1.turns[0].contextBefore, 0);
    assert.equal(tl1.turns[0].contextAfter, 4000);
    assert.equal(tl1.turns[0].contextDelta, 4000);

    // Mesaj 1: stripped wrapper, 2 PLANNER_RESPONSE steps, thinking + visible == output
    const t1 = tl1.turns[1];
    assert.equal(t1.isPreUser, false);
    assert.equal(t1.index, 1);
    assert.equal(t1.promptPreview, 'Merhaba, projeyi analiz et.');
    assert.equal(t1.userPromptTokensEst, Math.ceil('Merhaba, projeyi analiz et.'.length / 4));
    assert.equal(t1.stepCount, 2);
    assert.equal(t1.thinkingTokens, 1800);
    assert.equal(t1.visibleOutputTokens, 900);
    assert.equal(t1.outputTokens, 2700);
    assert.equal(t1.freshInputTokens, 35000);
    assert.equal(t1.cacheReadTokens, 45000);
    assert.equal(t1.totalProcessedTokens, 35000 + 45000 + 2700);
    assert.equal(t1.contextBefore, 4000);
    assert.equal(t1.contextAfter, 50000);
    assert.equal(t1.contextDelta, 46000);

    // Mesaj 2: compaction -> contextBefore 50000 -> contextAfter 20000 -> contextDelta -30000
    const t2 = tl1.turns[2];
    assert.equal(t2.index, 2);
    assert.equal(t2.compactionCount, 1);
    assert.equal(t2.contextBefore, 50000);
    assert.equal(t2.contextAfter, 20000);
    assert.equal(t2.contextDelta, -30000);

    // Cache hit check
    const cachedEntry = tracker._timelineCache.get(convId);
    assert.ok(cachedEntry);
    const tl2 = tracker.getMessageTimeline(convId);
    assert.strictEqual(tracker._timelineCache.get(convId), cachedEntry, 'Expected timeline cache hit');
    assert.equal(tl2.turns.length, 3);

    // Append a new user message -> invalidates timeline cache
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Yeni soru', created_at: '2026-11-23T06:03:00Z' }) + '\n',
      'utf8'
    );
    const tl3 = tracker.getMessageTimeline(convId);
    assert.notStrictEqual(tracker._timelineCache.get(convId), cachedEntry, 'Timeline cache must invalidate on append');
    assert.equal(tl3.totals.messageCount, 3);

    tracker.dispose();
  } finally {
    rmDirSafe(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 14. v1.4.0: Thinking Split Rendering & Zero-Emoji / Package Hygiene
// ---------------------------------------------------------------------------

test('views v1.4.0: Mesaj Akışı renders numeric thinking tokens when hasThinkingSplit is true', async () => {
  const tmpDir = makeTempDir('token-sayar-views-think-');
  const fakeHome = path.join(tmpDir, 'home');
  const agyDir = path.join(fakeHome, '.gemini', 'antigravity');
  const wsDir = path.join(tmpDir, 'ws-think');
  const wsStorageExtDir = path.join(tmpDir, 'wsStorage', 'local.token-sayar');
  const wsStateDb = path.join(tmpDir, 'wsStorage', 'state.vscdb');
  const globalStorageExtDir = path.join(tmpDir, 'globalStorage', 'local.token-sayar');

  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(wsStorageExtDir, { recursive: true });
  fs.mkdirSync(globalStorageExtDir, { recursive: true });
  fs.mkdirSync(path.join(agyDir, 'annotations'), { recursive: true });

  const convId = '66666666-7777-8888-9999-aaaaaaaaaaaa';
  const nowSec = Math.floor(Date.now() / 1000);
  const wsUri = 'file:///' + wsDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}%3A`);

  fs.writeFileSync(
    path.join(agyDir, 'agyhub_summaries_proto.pb'),
    buildSummaryEntry({
      id: convId,
      title: 'Düşünme Ayrımı Testi',
      stepCount: 2,
      lastModifiedSec: nowSec,
      status: 2,
      workspaceUri: wsUri,
    })
  );
  createStateDb(wsStateDb, { lastConversationId: convId });
  createConversationDb(path.join(agyDir, 'conversations', `${convId}.db`), {
    contextBudget: 256000,
    modelDisplayName: 'Gemini 4 Neon (High)',
  });
  const db = new DatabaseSync(path.join(agyDir, 'conversations', `${convId}.db`));
  try {
    db.prepare('DELETE FROM gen_metadata').run();
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      1,
      buildGenMetadataWithUsage({
        displayName: 'Gemini 4 Neon (High)',
        inputTokens: 8000,
        outputTokens: 2000,
        cacheReadTokens: 20000,
        thinkingTokens: 1200,
        visibleOutputTokens: 800,
      })
    );
  } finally {
    db.close();
  }
  writeTranscript(
    agyDir,
    convId,
    [
      JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content: 'Düşünme testi',
        created_at: '2026-11-23T06:00:00Z',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        input_tokens: 8000,
        cache_read_tokens: 20000,
        output_tokens: 2000,
        model: 'gemini-4-neon-high',
        created_at: '2026-11-23T06:00:10Z',
      }),
    ].join('\n') + '\n'
  );

  const vscodeMock = createMockVscode({ enabled: true }, [wsDir]);
  const loaded = loadExtensionWithMocks(vscodeMock, fakeHome);
  const context = {
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    storageUri: { fsPath: wsStorageExtDir },
    globalStorageUri: { fsPath: globalStorageExtDir },
    subscriptions: [],
  };

  try {
    loaded.ext.activate(context);
    vscodeMock.__state.setTreeViewVisible('tokenSayar.timeline', true);
    const turns = vscodeMock.__state.getTreeViewChildren('tokenSayar.timeline');
    assert.equal(turns.length, 1);
    const children = vscodeMock.__state.getTreeViewChildren('tokenSayar.timeline', turns[0]);
    assert.equal(children.find((c) => c.label === '3. Model düşünmesi (geçici)').description, '1,2K');
    assert.equal(children.find((c) => c.label === '4. Model yanıtı ve araç çağrıları').description, '800');

    loaded.ext.deactivate();
    for (const sub of context.subscriptions) {
      if (sub && typeof sub.dispose === 'function') {
        sub.dispose();
      }
    }
  } finally {
    try {
      loaded.ext.deactivate();
    } catch {
      // ignore
    }
    loaded.restore();
    rmDirSafe(tmpDir);
  }
});

test('v1.4.0 hygiene: version 1.4.0, 2 views only, zero-emoji across src/*.js, media/help.md, package.json, README.md, no sidebar.js, and package-vsix includes views.js + help.md', () => {
  const rootDir = path.resolve(__dirname, '..');
  const srcDir = path.join(rootDir, 'src');
  const srcFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).map((f) => path.join(srcDir, f));
  const filesToScan = [
    ...srcFiles,
    path.join(rootDir, 'media', 'help.md'),
    path.join(rootDir, 'package.json'),
    path.join(rootDir, 'README.md'),
  ];

  for (const filePath of filesToScan) {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/\p{Extended_Pictographic}/u);
    assert.equal(
      match,
      null,
      `Found prohibited emoji "${match && match[0]}" in ${path.relative(rootDir, filePath)}`
    );
  }

  // No src/sidebar.js and no sidebar module/view reference in src/extension.js (ignoring codicon $(layout-sidebar-left))
  assert.equal(fs.existsSync(path.join(srcDir, 'sidebar.js')), false, 'src/sidebar.js must not exist');
  const extensionSource = fs.readFileSync(path.join(srcDir, 'extension.js'), 'utf8');
  const extensionWithoutCodicon = extensionSource.replace(/\$\(layout-sidebar-left\)/g, '');
  assert.equal(/sidebar/i.test(extensionWithoutCodicon), false, 'src/extension.js must have no reference to sidebar');

  // package.json v1.4.x checks: 2 views only, exportReport command, notifications setting, icon
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.4.1');
  assert.equal(pkg.icon, 'media/logo.png');
  assert.ok(fs.existsSync(path.join(rootDir, 'media', 'logo.png')), 'media/logo.png must exist');
  const sidebarViews = pkg.contributes.views['token-sayar-sidebar'];
  assert.deepEqual(
    sidebarViews.map((v) => v.id),
    ['tokenSayar.context', 'tokenSayar.timeline']
  );
  assert.equal(sidebarViews.some((v) => v.id === 'tokenSayar.conversations'), false);
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'tokenSayar.exportReport'));
  assert.equal(pkg.contributes.configuration.properties['tokenSayar.notifications'].default, true);

  // package-vsix.js packages src/views.js and media/help.md, NOT src/sidebar.js
  const packageVsixSource = fs.readFileSync(path.join(rootDir, 'scripts', 'package-vsix.js'), 'utf8');
  assert.ok(packageVsixSource.includes("'src/views.js'"), 'package-vsix.js must package src/views.js');
  assert.ok(packageVsixSource.includes("'media/help.md'"), 'package-vsix.js must package media/help.md');
  assert.equal(packageVsixSource.includes('sidebar.js'), false, 'package-vsix.js must not reference sidebar.js');
});

// ---------------------------------------------------------------------------
// 15. v1.4.0: buildThresholdBar, Capacity Estimation, Step Trace, exportReport & Notifications
// ---------------------------------------------------------------------------

test('views v1.4.0: buildThresholdBar renders 20 cells with threshold markers across edge cases', () => {
  const cases = [
    { percent: 0, warn: 55, danger: 80, expected: '▱▱▱▱▱▱▱▱▱▱│▱▱▱▱┃▱▱▱▱' },
    { percent: 26.8, warn: 55, danger: 80, expected: '▰▰▰▰▰▱▱▱▱▱│▱▱▱▱┃▱▱▱▱' },
    { percent: 55, warn: 55, danger: 80, expected: '▰▰▰▰▰▰▰▰▰▰│▱▱▱▱┃▱▱▱▱' },
    { percent: 80, warn: 55, danger: 80, expected: '▰▰▰▰▰▰▰▰▰▰│▰▰▰▰┃▱▱▱▱' },
    { percent: 100, warn: 55, danger: 80, expected: '▰▰▰▰▰▰▰▰▰▰│▰▰▰▰┃▰▰▰▰' },
    { percent: 40, warn: 50, danger: 50, expected: '▰▰▰▰▰▰▰▰│┃▱▱▱▱▱▱▱▱▱▱' },
    { percent: -15, warn: 55, danger: 80, expected: '▱▱▱▱▱▱▱▱▱▱│▱▱▱▱┃▱▱▱▱' },
    { percent: 150, warn: 55, danger: 80, expected: '▰▰▰▰▰▰▰▰▰▰│▰▰▰▰┃▰▰▰▰' },
    { percent: NaN, warn: 55, danger: 80, expected: '▱▱▱▱▱▱▱▱▱▱│▱▱▱▱┃▱▱▱▱' },
  ];

  for (const tc of cases) {
    const bar = buildThresholdBar(tc.percent, tc.warn, tc.danger);
    assert.equal(Array.from(bar).length, 20, `Expected 20 cells for percent=${tc.percent}`);
    assert.equal(bar, tc.expected, `Mismatch for percent=${tc.percent}, warn=${tc.warn}, danger=${tc.danger}`);
    assert.ok(bar.includes('│'), 'Warn marker │ expected');
    assert.ok(bar.includes('┃'), 'Danger marker ┃ expected');
  }
});

test('tracker v1.4.0: avgContextGrowthPerMessage & estimatedRemainingMessages live/inspect/truncation + timeline steps & context math', () => {
  const tmpDir = makeTempDir('token-sayar-v14-tracker-');
  try {
    const agyDir = path.join(tmpDir, 'antigravity');
    const liveConv = 'conv-v14-live';
    const otherConv = 'conv-v14-other';

    // liveConv:
    // Turn 1: prompt 20 chars (est=5), step 1 ctx=10000, step 2 ctx=20000 -> growth=+20000
    // Turn 2: prompt 40 chars (est=10), CHECKPOINT + PLANNER ctx=50000 -> growth=+30000
    // Avg growth across completed Turn 1 + active Turn 2?
    // When Turn 2 USER_INPUT arrives, Turn 1 delta (+20000) is recorded. On Turn 3 USER_INPUT, Turn 2 delta (+30000) is recorded -> avg = 25000.
    // Let's write 3 USER_INPUT turns so Turn 1 (+20000) and Turn 2 (+30000) are completed and averaged!
    const livePath = writeTranscript(
      agyDir,
      liveConv,
      [
        JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '12345678901234567890', created_at: '2026-11-23T06:00:00Z' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 2000, cache_read_tokens: 8000, output_tokens: 200, model: 'gemini-4-neon-high', created_at: '2026-11-23T06:00:05Z' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 5000, cache_read_tokens: 15000, output_tokens: 300, model: 'gemini-4-neon-high', created_at: '2026-11-23T06:00:10Z' }),
        JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '1234567890123456789012345678901234567890', created_at: '2026-11-23T06:01:00Z' }),
        JSON.stringify({ type: 'CHECKPOINT', created_at: '2026-11-23T06:01:02Z' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 10000, cache_read_tokens: 40000, output_tokens: 400, model: 'gemini-4-neon-high', created_at: '2026-11-23T06:01:10Z' }),
        JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Son mesaj', created_at: '2026-11-23T06:02:00Z' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 12000, cache_read_tokens: 50000, output_tokens: 250, model: 'gemini-4-neon-high', created_at: '2026-11-23T06:02:10Z' }),
      ].join('\n') + '\n'
    );

    // otherConv for inspectConversation capacity check:
    // Turn 1: 0 -> 100,000 (+100K), Turn 2: 100,000 -> 150,000 (avg = 100,000 from completed Turn 1; limit = 512,000; rem = 362,000 -> floor(362000/100000) = 3)
    writeTranscript(
      agyDir,
      otherConv,
      [
        JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'İlk' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 10000, cache_read_tokens: 90000, output_tokens: 100, model: 'gemini-4-neon-high' }),
        JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'İkinci' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 10000, cache_read_tokens: 140000, output_tokens: 100, model: 'gemini-4-neon-high' }),
      ].join('\n') + '\n'
    );

    const tracker = new TokenTracker({
      antigravityDir: agyDir,
      config: { enabled: true, defaultContextLimit: 512000 },
    });
    tracker.setPinnedConversation(liveConv);
    let snap = tracker.refresh();

    // Completed turns 1 (+20000) and 2 (+30000) -> avgContextGrowthPerMessage = 25000
    // contextTokens = 62000, limit = 512000 -> remaining = 450000 -> floor(450000 / 25000) = 18
    assert.equal(snap.contextTokens, 62000);
    assert.equal(snap.avgContextGrowthPerMessage, 25000);
    assert.equal(snap.estimatedRemainingMessages, 18);

    // inspectConversation also computes avgContextGrowthPerMessage & estimatedRemainingMessages
    const inspected = tracker.inspectConversation(otherConv);
    assert.equal(inspected.contextTokens, 150000);
    assert.equal(inspected.avgContextGrowthPerMessage, 100000);
    assert.equal(inspected.estimatedRemainingMessages, 3);

    // Timeline steps (CHECKPOINT & PLANNER_RESPONSE) + totalReadTokens + addedContextFromPrompt + addedContextFromToolsAndReplies
    const tl = tracker.getMessageTimeline(liveConv);
    assert.equal(tl.turns.length, 3);
    assert.equal(tl.turns[0].steps.length, 2);
    assert.deepEqual(
      tl.turns[0].steps.map((s) => [s.stepNumber, s.type, s.contextTokens]),
      [
        [1, 'PLANNER_RESPONSE', 10000],
        [2, 'PLANNER_RESPONSE', 20000],
      ]
    );
    assert.equal(tl.turns[0].totalReadTokens, (2000 + 8000) + (5000 + 15000));
    assert.equal(tl.turns[0].addedContextFromPrompt, 5);
    assert.equal(tl.turns[0].addedContextFromToolsAndReplies, 20000 - 5);

    assert.equal(tl.turns[1].steps.length, 2);
    assert.equal(tl.turns[1].steps[0].type, 'CHECKPOINT');
    assert.equal(tl.turns[1].steps[1].type, 'PLANNER_RESPONSE');
    assert.equal(tl.turns[1].steps[1].contextTokens, 50000);
    assert.equal(tl.turns[1].totalReadTokens, 50000);
    assert.equal(tl.turns[1].addedContextFromPrompt, 10);
    assert.equal(tl.turns[1].addedContextFromToolsAndReplies, 30000 - 10);

    // Truncation reset clears growth accumulator
    fs.writeFileSync(
      livePath,
      JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 4000, output_tokens: 50, model: 'gemini-4-neon-high' }) + '\n',
      'utf8'
    );
    snap = tracker.refresh();
    assert.equal(snap.contextTokens, 5000);
    assert.equal(snap.avgContextGrowthPerMessage, null);
    assert.equal(snap.estimatedRemainingMessages, null);

    tracker.dispose();
  } finally {
    rmDirSafe(tmpDir);
  }
});

test('views v1.4.0: tokenSayar.exportReport opens emoji-free Markdown report via openTextDocument + showTextDocument', async () => {
  const tmpDir = makeTempDir('token-sayar-export-');
  const fakeHome = path.join(tmpDir, 'home');
  const agyDir = path.join(fakeHome, '.gemini', 'antigravity');
  const wsDir = path.join(tmpDir, 'ws-export');
  const wsStorageExtDir = path.join(tmpDir, 'wsStorage', 'local.token-sayar');
  const wsStateDb = path.join(tmpDir, 'wsStorage', 'state.vscdb');
  const globalStorageExtDir = path.join(tmpDir, 'globalStorage', 'local.token-sayar');

  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(wsStorageExtDir, { recursive: true });
  fs.mkdirSync(globalStorageExtDir, { recursive: true });
  fs.mkdirSync(path.join(agyDir, 'annotations'), { recursive: true });

  const convId = '77777777-1111-2222-3333-888888888888';
  const nowSec = Math.floor(Date.now() / 1000);
  const wsUri = 'file:///' + wsDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}%3A`);

  fs.writeFileSync(
    path.join(agyDir, 'agyhub_summaries_proto.pb'),
    buildSummaryEntry({
      id: convId,
      title: 'Rapor Test Sohbeti',
      stepCount: 4,
      lastModifiedSec: nowSec,
      status: 2,
      workspaceUri: wsUri,
    })
  );
  createStateDb(wsStateDb, { lastConversationId: convId });
  createConversationDb(path.join(agyDir, 'conversations', `${convId}.db`), {
    contextBudget: 256000,
    modelDisplayName: 'Gemini 4 Neon (High)',
  });
  writeTranscript(
    agyDir,
    convId,
    [
      JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Rapor oluştur', created_at: '2026-11-23T06:00:00Z' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 10000, cache_read_tokens: 50000, output_tokens: 500, model: 'gemini-4-neon-high', created_at: '2026-11-23T06:00:10Z' }),
    ].join('\n') + '\n'
  );

  const vscodeMock = createMockVscode({ enabled: true }, [wsDir]);
  const loaded = loadExtensionWithMocks(vscodeMock, fakeHome);
  const context = {
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    storageUri: { fsPath: wsStorageExtDir },
    globalStorageUri: { fsPath: globalStorageExtDir },
    subscriptions: [],
  };

  try {
    loaded.ext.activate(context);
    await vscodeMock.commands.executeCommand('tokenSayar.exportReport');

    assert.equal(vscodeMock.__state.openedTextDocuments.length, 1);
    assert.equal(vscodeMock.__state.shownTextDocuments.length, 1);
    const doc = vscodeMock.__state.openedTextDocuments[0];
    assert.strictEqual(vscodeMock.__state.shownTextDocuments[0], doc);
    assert.equal(doc.languageId, 'markdown');

    const md = doc.content;
    assert.equal(/\p{Extended_Pictographic}/u.test(md), false, 'Exported report must be emoji-free');
    assert.ok(md.includes('# Token Sayar Raporu: Rapor Test Sohbeti'));
    assert.ok(md.includes('## Bağlam Özeti'));
    assert.ok(md.includes('| Doluluk | 60K / 256K (%23,4)'));
    assert.ok(md.includes('## Eşik Tablosu'));
    assert.ok(md.includes('## Mesaj Akışı (1 -> 5 Adım Dağılımı)'));
    assert.ok(md.includes('1. Senin mesajın:'));
    assert.ok(md.includes('2. Modele okutulan bağlam (1 adım):'));
    assert.ok(md.includes('3. Model düşünmesi (geçici):'));
    assert.ok(md.includes('4. Model yanıtı ve araç çağrıları:'));
    assert.ok(md.includes('5. Net bağlam değişimi (kalıcı):'));

    loaded.ext.deactivate();
    for (const sub of context.subscriptions) {
      if (sub && typeof sub.dispose === 'function') {
        sub.dispose();
      }
    }
  } finally {
    try {
      loaded.ext.deactivate();
    } catch {
      // ignore
    }
    loaded.restore();
    rmDirSafe(tmpDir);
  }
});

test('extension v1.4.0: danger warning notification fires ONCE per conversation ID, opens panel on action, and respects tokenSayar.notifications=false', async () => {
  const tmpDir = makeTempDir('token-sayar-notify-');
  const fakeHome = path.join(tmpDir, 'home');
  const agyDir = path.join(fakeHome, '.gemini', 'antigravity');
  const wsDir = path.join(tmpDir, 'ws-notify');
  const wsStorageExtDir = path.join(tmpDir, 'wsStorage', 'local.token-sayar');
  const wsStateDb = path.join(tmpDir, 'wsStorage', 'state.vscdb');
  const globalStorageExtDir = path.join(tmpDir, 'globalStorage', 'local.token-sayar');

  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(wsStorageExtDir, { recursive: true });
  fs.mkdirSync(globalStorageExtDir, { recursive: true });
  fs.mkdirSync(path.join(agyDir, 'annotations'), { recursive: true });

  const conv1 = '88888888-1111-2222-3333-111111111111';
  const conv2 = '88888888-1111-2222-3333-222222222222';
  const conv3 = '88888888-1111-2222-3333-333333333333';
  const nowSec = Math.floor(Date.now() / 1000);
  const wsUri = 'file:///' + wsDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}%3A`);

  fs.writeFileSync(
    path.join(agyDir, 'agyhub_summaries_proto.pb'),
    Buffer.concat([
      buildSummaryEntry({ id: conv1, title: 'Uyarı Sohbet 1', stepCount: 2, lastModifiedSec: nowSec, status: 2, workspaceUri: wsUri }),
      buildSummaryEntry({ id: conv2, title: 'Uyarı Sohbet 2', stepCount: 2, lastModifiedSec: nowSec - 10, status: 1, workspaceUri: wsUri }),
      buildSummaryEntry({ id: conv3, title: 'Uyarı Sohbet 3', stepCount: 2, lastModifiedSec: nowSec - 20, status: 1, workspaceUri: wsUri }),
    ])
  );
  createStateDb(wsStateDb, { lastConversationId: conv1 });
  createConversationDb(path.join(agyDir, 'conversations', `${conv1}.db`), { contextBudget: 100000 });
  createConversationDb(path.join(agyDir, 'conversations', `${conv2}.db`), { contextBudget: 100000 });
  createConversationDb(path.join(agyDir, 'conversations', `${conv3}.db`), { contextBudget: 100000 });

  const tr1 = writeTranscript(
    agyDir,
    conv1,
    JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 50000, cache_read_tokens: 0, output_tokens: 100, model: 'gemini-4-neon-high' }) + '\n'
  );
  writeTranscript(
    agyDir,
    conv2,
    JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 85000, cache_read_tokens: 0, output_tokens: 100, model: 'gemini-4-neon-high' }) + '\n'
  );
  writeTranscript(
    agyDir,
    conv3,
    JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 90000, cache_read_tokens: 0, output_tokens: 100, model: 'gemini-4-neon-high' }) + '\n'
  );

  const vscodeMock = createMockVscode({ enabled: true, dangerPercent: 80, notifications: true }, [wsDir]);
  vscodeMock.__state.setWarningMessageHandler(async (_msg, btn) => btn); // Simulate clicking 'Görünümü Aç'
  const loaded = loadExtensionWithMocks(vscodeMock, fakeHome);
  const context = {
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    storageUri: { fsPath: wsStorageExtDir },
    globalStorageUri: { fsPath: globalStorageExtDir },
    subscriptions: [],
  };

  try {
    loaded.ext.activate(context);
    // Initial 50% -> below dangerPercent -> 0 warnings
    assert.equal(vscodeMock.__state.warningMessages.length, 0);

    // Cross dangerPercent (82%) on conv1 -> fires ONCE + clicking 'Görünümü Aç' runs tokenSayar.openPanel
    fs.appendFileSync(
      tr1,
      JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 82000, cache_read_tokens: 0, output_tokens: 100, model: 'gemini-4-neon-high' }) + '\n'
    );
    await vscodeMock.commands.executeCommand('tokenSayar.refresh');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(vscodeMock.__state.warningMessages.length, 1);
    assert.deepEqual(vscodeMock.__state.warningMessages[0].items, ['Görünümü Aç']);
    assert.ok(vscodeMock.__state.warningMessages[0].message.includes('%82'));
    assert.ok(vscodeMock.__state.executedCommands.some((c) => c.id === 'tokenSayar.openPanel'));

    // Subsequent updates for same conv1 (88%, still >= 80%) must NOT repeat warning
    fs.appendFileSync(
      tr1,
      JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 88000, cache_read_tokens: 0, output_tokens: 100, model: 'gemini-4-neon-high' }) + '\n'
    );
    await vscodeMock.commands.executeCommand('tokenSayar.refresh');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(vscodeMock.__state.warningMessages.length, 1);

    // Switching active conversation to conv2 (85% >= 80%) fires ONCE for conv2
    await vscodeMock.commands.executeCommand('tokenSayar.pinToStatusBar', conv2);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(vscodeMock.__state.warningMessages.length, 2);

    // Disabling tokenSayar.notifications suppresses notification for conv3 (90%)
    vscodeMock.__state.fireConfigChange({ notifications: false });
    await vscodeMock.commands.executeCommand('tokenSayar.pinToStatusBar', conv3);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(vscodeMock.__state.warningMessages.length, 2);

    loaded.ext.deactivate();
    for (const sub of context.subscriptions) {
      if (sub && typeof sub.dispose === 'function') {
        sub.dispose();
      }
    }
  } finally {
    try {
      loaded.ext.deactivate();
    } catch {
      // ignore
    }
    loaded.restore();
    rmDirSafe(tmpDir);
  }
});

