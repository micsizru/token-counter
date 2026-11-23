'use strict';

/**
 * Token budget, bloat-level, capacity estimation, and efficiency status helpers.
 * Exports model limit defaults, config normalization, snapshot builders, and display formatters.
 */

const DEFAULT_MODEL_LIMITS = Object.freeze({
  'gemini-4': 512000,
  'gemini-3': 256000,
  'gemini-2.5': 256000,
  'gemini-2': 256000,
  'gemini-pro': 128000,
  'gemini-default': 256000,
  claude: 200000,
  gpt: 128000,
  o1: 128000,
  o3: 200000,
  o4: 200000,
});

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  warnPercent: 55,
  dangerPercent: 80,
  defaultContextLimit: 512000,
  compactDisplay: false,
  modelLimits: {},
});

/**
 * Format a token count cleanly for status bar and tooltip display.
 * Examples: 0 -> "0", 850 -> "850", 42310 -> "42.3K", 512000 -> "512K", 1250000 -> "1.25M".
 *
 * @param {number} count
 * @returns {string}
 */
function formatTokenCount(count) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
    return '0';
  }
  const n = Math.round(count);
  if (n < 1000) {
    return String(n);
  }
  if (n >= 999500) {
    const m = n / 1000000;
    const formatted = m >= 10 ? m.toFixed(1) : m.toFixed(2);
    return formatted.replace(/\.?0+$/, '') + 'M';
  }
  if (n >= 100000) {
    return Math.round(n / 1000) + 'K';
  }
  const k = n / 1000;
  return k.toFixed(1).replace(/\.0$/, '') + 'K';
}

/**
 * Return plain-Turkish non-technical efficiency guidance for a given fill percentage.
 *
 * @param {number | null | undefined} percent
 * @param {'none' | 'ok' | 'warn' | 'danger' | string} [bloatLevel]
 * @param {object} [config]
 * @returns {{ tier: string, badge: string, color: string, headline: string, advice: string }}
 */
function getEfficiencyStatus(percent, bloatLevel, config) {
  if (
    percent === null ||
    percent === undefined ||
    typeof percent !== 'number' ||
    !Number.isFinite(percent) ||
    bloatLevel === 'none'
  ) {
    return {
      tier: 'none',
      badge: 'Bekleniyor',
      color: 'muted',
      headline: 'Henüz token verisi yok',
      advice: 'Bir sohbet başlattığında veya seçtiğinde doluluk burada görünecek.',
    };
  }

  const cfg = config && typeof config === 'object' ? config : DEFAULT_CONFIG;
  const warnPercent = Number.isFinite(Number(cfg.warnPercent))
    ? Number(cfg.warnPercent)
    : DEFAULT_CONFIG.warnPercent;
  const dangerPercent = Number.isFinite(Number(cfg.dangerPercent))
    ? Number(cfg.dangerPercent)
    : DEFAULT_CONFIG.dangerPercent;
  const criticalPercent = Math.max(92, dangerPercent);

  if (percent >= criticalPercent) {
    return {
      tier: 'critical',
      badge: 'Verim: Çok Düşük (Kritik)',
      color: 'red',
      headline: 'Sohbet tamamen şişti!',
      advice: 'Otomatik sıkıştırma an meselesi ve verim çok düşük. Yeni sohbet açman şiddetle önerilir.',
    };
  }

  if (percent >= dangerPercent) {
    return {
      tier: 'low',
      badge: 'Verim: Düşük (Şişti)',
      color: 'orange',
      headline: 'Sohbet şişti!',
      advice: 'Bağlam dolmak üzere, model eski detayları kaçırabilir. /compact yapman veya yeni sohbet açman önerilir.',
    };
  }

  if (percent >= warnPercent) {
    return {
      tier: 'degrading',
      badge: 'Verim: Düşmeye Başladı',
      color: 'yellow',
      headline: 'Sohbet şişmeye başladı',
      advice: 'Bağlam doluyor; yanıt kalitesi hafifçe düşebilir. Yakında /compact veya yeni sohbet düşünebilirsin.',
    };
  }

  if (percent < Math.min(35, warnPercent)) {
    return {
      tier: 'excellent',
      badge: 'Verim: Çok İyi',
      color: 'green',
      headline: 'Sohbet tertemiz',
      advice: 'Yapay zeka tüm bağlamı net hatırlıyor, verim en yüksek seviyede.',
    };
  }

  return {
    tier: 'good',
    badge: 'Verim: İyi',
    color: 'green',
    headline: 'Sohbet sağlıklı ilerliyor',
    advice: 'Henüz belirgin bir şişme yok, rahatça devam edebilirsin.',
  };
}

/**
 * Match a model ID against a mapping table (exact match first, then longest prefix/substring match).
 *
 * @param {string} model
 * @param {Record<string, number>} table
 * @returns {number | null}
 */
function matchModelLimit(model, table) {
  if (!model || typeof model !== 'string' || !table || typeof table !== 'object') {
    return null;
  }
  const needle = model.trim().toLowerCase();
  if (!needle) {
    return null;
  }

  let bestLimit = null;
  let bestScore = -1;

  for (const [rawKey, rawVal] of Object.entries(table)) {
    const val = Number(rawVal);
    if (!Number.isFinite(val) || val <= 0) {
      continue;
    }
    const key = String(rawKey).trim().toLowerCase();
    if (!key) {
      continue;
    }

    let score = -1;
    if (needle === key) {
      score = 10000 + key.length;
    } else if (needle.startsWith(key)) {
      score = 1000 + key.length;
    } else if (needle.includes(key)) {
      score = key.length;
    }

    if (score > bestScore) {
      bestScore = score;
      bestLimit = Math.round(val);
    }
  }

  return bestLimit;
}

/**
 * Normalize raw tracker configuration with safe defaults.
 *
 * @param {object} [raw]
 * @returns {{ enabled: boolean, warnPercent: number, dangerPercent: number, defaultContextLimit: number, compactDisplay: boolean, modelLimits: Record<string, number> }}
 */
function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const warnPercent = Number.isFinite(Number(cfg.warnPercent))
    ? Number(cfg.warnPercent)
    : DEFAULT_CONFIG.warnPercent;
  const dangerPercent = Number.isFinite(Number(cfg.dangerPercent))
    ? Number(cfg.dangerPercent)
    : DEFAULT_CONFIG.dangerPercent;
  const defaultLimitRaw = Number(cfg.defaultContextLimit);
  const defaultContextLimit =
    Number.isFinite(defaultLimitRaw) && defaultLimitRaw > 0
      ? Math.round(defaultLimitRaw)
      : DEFAULT_CONFIG.defaultContextLimit;

  return {
    enabled: cfg.enabled !== undefined ? Boolean(cfg.enabled) : DEFAULT_CONFIG.enabled,
    warnPercent,
    dangerPercent,
    defaultContextLimit,
    compactDisplay: Boolean(cfg.compactDisplay),
    modelLimits: cfg.modelLimits && typeof cfg.modelLimits === 'object' ? { ...cfg.modelLimits } : {},
  };
}

/**
 * Build an empty TrackerSnapshot-shaped object.
 *
 * @param {boolean} enabled
 * @param {string | null} [note]
 * @param {string | null} [pinnedConversationId]
 * @param {number} [defaultContextLimit]
 * @returns {object}
 */
function buildEmptySnapshot(enabled, note, pinnedConversationId, defaultContextLimit) {
  const limit =
    typeof defaultContextLimit === 'number' && Number.isFinite(defaultContextLimit) && defaultContextLimit > 0
      ? Math.round(defaultContextLimit)
      : DEFAULT_CONFIG.defaultContextLimit;

  return {
    enabled: Boolean(enabled),
    mode: pinnedConversationId ? 'pinned' : 'auto',
    conversationId: pinnedConversationId || null,
    title: '',
    status: 'unknown',
    model: null,
    modelDisplayName: null,
    modelsUsed: [],
    contextTokens: 0,
    contextLimit: limit,
    contextLimitSource: 'default',
    percent: 0,
    bloatLevel: 'none',
    lastInputTokens: 0,
    lastCacheReadTokens: 0,
    lastOutputTokens: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
    compactionCount: 0,
    avgContextGrowthPerMessage: null,
    estimatedRemainingMessages: null,
    lastUpdatedAt: null,
    hasTranscript: false,
    note: note || null,
  };
}

/**
 * Compute bloat level ('ok' | 'warn' | 'danger') from fill percentage and config thresholds.
 *
 * @param {number} percent
 * @param {object} [config]
 * @returns {'ok' | 'warn' | 'danger'}
 */
function computeBloatLevel(percent, config) {
  const cfg = config && typeof config === 'object' ? config : DEFAULT_CONFIG;
  const dangerPercent = Number.isFinite(Number(cfg.dangerPercent))
    ? Number(cfg.dangerPercent)
    : DEFAULT_CONFIG.dangerPercent;
  const warnPercent = Number.isFinite(Number(cfg.warnPercent))
    ? Number(cfg.warnPercent)
    : DEFAULT_CONFIG.warnPercent;

  if (percent >= dangerPercent) {
    return 'danger';
  }
  if (percent >= warnPercent) {
    return 'warn';
  }
  return 'ok';
}

/**
 * Compute average context growth per user message and estimated remaining messages.
 *
 * @param {object} state
 * @param {number} contextLimit
 * @returns {{ avgContextGrowthPerMessage: number | null, estimatedRemainingMessages: number | null }}
 */
function computeCapacityMetrics(state, contextLimit) {
  let avgContextGrowthPerMessage = null;
  if (state.positiveTurnGrowthCount > 0) {
    avgContextGrowthPerMessage = Math.round(
      state.positiveTurnGrowthSum / state.positiveTurnGrowthCount
    );
  } else if (
    state.seenUserInput &&
    state.contextTokens - state.currentUserTurnStartContext > 0
  ) {
    avgContextGrowthPerMessage = Math.round(
      state.contextTokens - state.currentUserTurnStartContext
    );
  }

  const limit =
    typeof contextLimit === 'number' && Number.isFinite(contextLimit)
      ? contextLimit
      : 0;
  const remainingTokens = Math.max(0, limit - state.contextTokens);
  const estimatedRemainingMessages =
    state.hasTranscript &&
    avgContextGrowthPerMessage !== null &&
    avgContextGrowthPerMessage > 0 &&
    remainingTokens > 0
      ? Math.max(1, Math.floor(remainingTokens / avgContextGrowthPerMessage))
      : null;

  return {
    avgContextGrowthPerMessage,
    estimatedRemainingMessages,
  };
}

/**
 * Merge and deduplicate model names from conversation DB metadata and transcript records.
 *
 * @param {string[] | null | undefined} dbModels
 * @param {string[] | null | undefined} transcriptModels
 * @returns {string[]}
 */
function mergeModelsUsed(dbModels, transcriptModels) {
  const merged = [];
  const seen = new Set();

  const addList = (list) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const raw of list) {
      if (typeof raw !== 'string') {
        continue;
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      const normKey = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const dedupKey = normKey || trimmed.toLowerCase();
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey);
        merged.push(trimmed);
      }
    }
  };

  addList(dbModels);
  addList(transcriptModels);
  return merged;
}

module.exports = {
  DEFAULT_MODEL_LIMITS,
  DEFAULT_CONFIG,
  formatTokenCount,
  getEfficiencyStatus,
  matchModelLimit,
  normalizeConfig,
  buildEmptySnapshot,
  computeBloatLevel,
  computeCapacityMetrics,
  mergeModelsUsed,
};
