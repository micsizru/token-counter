'use strict';

/**
 * @fileoverview Direct modular unit tests for extracted tracker, views, and extension modules,
 * recursive zero-emoji hygiene verification, and VSIX packaging completeness checks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  formatTokenCount,
  matchModelLimit,
  computeBloatLevel,
  computeCapacityMetrics,
  mergeModelsUsed,
} = require('../src/tracker/metrics');

const {
  trTokens,
  trDecimal,
  buildThresholdBar,
  getTierInfo,
  escapeMarkdown,
  resolveConversationTitle,
} = require('../src/views/format');

const {
  normalizeTurnStepMetrics,
} = require('../src/views/timeline-view');

const {
  configsEqual,
} = require('../src/extension/config');

const {
  collectSourceFiles,
} = require('../scripts/package-vsix');

const rootDir = path.resolve(__dirname, '..');

test('modules: src/tracker/metrics.js unit tests', () => {
  // formatTokenCount
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(-10), '0');
  assert.equal(formatTokenCount(NaN), '0');
  assert.equal(formatTokenCount(null), '0');
  assert.equal(formatTokenCount(450), '450');
  assert.equal(formatTokenCount(42310), '42.3K');
  assert.equal(formatTokenCount(100000), '100K');
  assert.equal(formatTokenCount(512000), '512K');
  assert.equal(formatTokenCount(1250000), '1.25M');
  assert.equal(formatTokenCount(12000000), '12M');

  // matchModelLimit
  const table = {
    'gemini-4': 512000,
    'gemini-3': 256000,
    claude: 200000,
    gpt: 128000,
  };
  assert.equal(matchModelLimit('claude', table), 200000);
  assert.equal(matchModelLimit('gemini-4-neon-high', table), 512000);
  assert.equal(matchModelLimit('custom-gpt-model', table), 128000);
  assert.equal(matchModelLimit('unknown-model', table), null);
  assert.equal(matchModelLimit('', table), null);
  assert.equal(matchModelLimit(null, table), null);

  // computeBloatLevel
  const cfg = { warnPercent: 55, dangerPercent: 80 };
  assert.equal(computeBloatLevel(20, cfg), 'ok');
  assert.equal(computeBloatLevel(55, cfg), 'warn');
  assert.equal(computeBloatLevel(70, cfg), 'warn');
  assert.equal(computeBloatLevel(80, cfg), 'danger');
  assert.equal(computeBloatLevel(95, cfg), 'danger');

  // computeCapacityMetrics
  const stateWithTurns = {
    positiveTurnGrowthCount: 3,
    positiveTurnGrowthSum: 30000,
    contextTokens: 40000,
    hasTranscript: true,
  };
  const cap = computeCapacityMetrics(stateWithTurns, 100000);
  assert.equal(cap.avgContextGrowthPerMessage, 10000);
  assert.equal(cap.estimatedRemainingMessages, 6);

  const emptyCap = computeCapacityMetrics({ hasTranscript: false, contextTokens: 0 }, 100000);
  assert.equal(emptyCap.avgContextGrowthPerMessage, null);
  assert.equal(emptyCap.estimatedRemainingMessages, null);

  // mergeModelsUsed
  const merged = mergeModelsUsed(
    ['gemini-4', 'claude-3.5-sonnet'],
    ['gemini-4', 'gpt-4o', '  ']
  );
  assert.deepEqual(merged, ['gemini-4', 'claude-3.5-sonnet', 'gpt-4o']);
});

test('modules: src/views/format.js unit tests', () => {
  // trTokens
  assert.equal(trTokens(42300), '42,3K');
  assert.equal(trTokens(512000), '512K');
  assert.equal(trTokens(0), '0');

  // trDecimal
  assert.equal(trDecimal(12.345, 1), '12,3');
  assert.equal(trDecimal(12.345, 2), '12,35');
  assert.equal(trDecimal(NaN, 1), '0,0');

  // buildThresholdBar
  const bar0 = buildThresholdBar(0);
  assert.equal(bar0.length, 20);
  assert.ok(bar0.includes('│'));
  assert.ok(bar0.includes('┃'));

  const bar50 = buildThresholdBar(50);
  assert.equal(bar50.length, 20);
  assert.ok(bar50.startsWith('▰'));

  // getTierInfo
  const tierOk = getTierInfo(20, 'ok');
  assert.equal(tierOk.label, 'Sağlıklı');
  assert.ok(tierOk.color);
  assert.ok(tierOk.advice);

  const tierWarn = getTierInfo(65, 'warn');
  assert.equal(tierWarn.label, 'Dolmaya başladı');

  const tierDanger = getTierInfo(85, 'danger');
  assert.equal(tierDanger.label, 'Dolu, sıkıştırma önerilir');

  // escapeMarkdown
  assert.equal(escapeMarkdown('hello *world* `code`'), 'hello \\*world\\* \\`code\\`');
  assert.equal(escapeMarkdown(null), '');

  // resolveConversationTitle
  assert.equal(resolveConversationTitle({ title: 'My Chat' }), 'My Chat');
  assert.equal(
    resolveConversationTitle({ conversationId: '12345678-abcd-ef01-2345-6789abcdef01' }),
    'Sohbet 12345678'
  );
  assert.equal(resolveConversationTitle(null), 'Token Sayar');
});

test('modules: src/views/timeline-view.js unit tests', () => {
  const normalized = normalizeTurnStepMetrics({
    stepCount: 2,
    freshInputTokens: 400,
    cacheReadTokens: 1600,
    thinkingTokens: 100,
    visibleOutputTokens: 250,
    contextDelta: 1200,
    contextBefore: 1000,
    contextAfter: 2200,
    userPromptTokensEst: 300,
  });

  assert.equal(normalized.stepCount, 2);
  assert.equal(normalized.freshInputTokens, 400);
  assert.equal(normalized.cacheReadTokens, 1600);
  assert.equal(normalized.totalReadTokens, 2000);
  assert.equal(normalized.avgReadPerStep, 1000);
  assert.equal(normalized.thinkingTokens, 100);
  assert.equal(normalized.visibleOutputTokens, 250);
  assert.equal(normalized.totalProcessedTokens, 2350);
  assert.equal(normalized.contextDelta, 1200);
  assert.equal(normalized.contextBefore, 1000);
  assert.equal(normalized.contextAfter, 2200);
  assert.equal(normalized.addedFromPrompt, 300);
  assert.equal(normalized.addedFromTools, 900);
});

test('modules: src/extension/config.js unit tests', () => {
  const baseConfig = {
    enabled: true,
    warnPercent: 55,
    dangerPercent: 80,
    defaultContextLimit: 512000,
    compactDisplay: false,
    statusBarClickAction: 'openPanel',
    notifications: true,
    modelLimits: { 'gemini-4': 512000 },
  };

  assert.equal(configsEqual(baseConfig, { ...baseConfig }), true);
  assert.equal(configsEqual(baseConfig, { ...baseConfig, enabled: false }), false);
  assert.equal(configsEqual(baseConfig, { ...baseConfig, warnPercent: 60 }), false);
  assert.equal(configsEqual(baseConfig, { ...baseConfig, dangerPercent: 75 }), false);
  assert.equal(configsEqual(baseConfig, { ...baseConfig, defaultContextLimit: 256000 }), false);
  assert.equal(configsEqual(baseConfig, { ...baseConfig, compactDisplay: true }), false);
  assert.equal(configsEqual(baseConfig, { ...baseConfig, statusBarClickAction: 'openMenu' }), false);
  assert.equal(configsEqual(baseConfig, { ...baseConfig, notifications: false }), false);
  assert.equal(
    configsEqual(baseConfig, { ...baseConfig, modelLimits: { 'gemini-4': 256000 } }),
    false
  );
  assert.equal(configsEqual(null, baseConfig), false);
  assert.equal(configsEqual(baseConfig, null), false);
});

test('modules: recursive zero-emoji hygiene check across all src/**/*.js, media/help.md, package.json, README.md', () => {
  function collectAllFiles(dir) {
    const list = [];
    if (!fs.existsSync(dir)) {
      return list;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        list.push(...collectAllFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        list.push(fullPath);
      }
    }
    return list;
  }

  const srcFiles = collectAllFiles(path.join(rootDir, 'src'));
  const allFilesToScan = [
    ...srcFiles,
    path.join(rootDir, 'scripts', 'install.js'),
    path.join(rootDir, 'scripts', 'uninstall.js'),
    path.join(rootDir, 'media', 'help.md'),
    path.join(rootDir, 'package.json'),
    path.join(rootDir, 'README.md'),
  ];

  for (const filePath of allFilesToScan) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/\p{Extended_Pictographic}/u);
    assert.equal(
      match,
      null,
      `Prohibited emoji "${match && match[0]}" found in ${path.relative(rootDir, filePath)}`
    );
  }
});

test('modules: packaging completeness covers all src/**/*.js in VSIX', () => {
  function collectAllJs(dir) {
    const list = [];
    if (!fs.existsSync(dir)) {
      return list;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        list.push(...collectAllJs(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        list.push(path.relative(rootDir, fullPath).replace(/\\/g, '/'));
      }
    }
    return list.sort();
  }

  const diskJsFiles = collectAllJs(path.join(rootDir, 'src'));
  const packagedJsFiles = collectSourceFiles(path.join(rootDir, 'src'));

  assert.ok(diskJsFiles.length >= 10, 'Expected multiple modular files in src/');
  for (const jsFile of diskJsFiles) {
    assert.ok(
      packagedJsFiles.includes(jsFile),
      `Expected ${jsFile} to be collected for VSIX packaging`
    );
  }
});

test('modules: scripts/install.js and scripts/uninstall.js exist and pass node -c', () => {
  const scripts = [
    path.join(rootDir, 'scripts', 'install.js'),
    path.join(rootDir, 'scripts', 'uninstall.js'),
  ];

  for (const scriptPath of scripts) {
    assert.ok(fs.existsSync(scriptPath), `Expected ${scriptPath} to exist`);
    execFileSync(process.execPath, ['--check', scriptPath], { stdio: 'pipe' });
  }
});
