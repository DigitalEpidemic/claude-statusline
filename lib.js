"use strict";

const crypto = require("crypto");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// Percent thresholds shared by session/weekly/extra-usage bars.
// < GOOD -> green, < WARN -> yellow, >= WARN -> red.
const THRESHOLDS = { good: 50, warn: 80 };

// Absolute token thresholds for the context token count, anchored to the
// ~120k "smart zone" limit past which response quality noticeably degrades
// — separate from THRESHOLDS since it's not a percentage of the raw window.
const CONTEXT_TOKEN_THRESHOLDS = { amber: 80_000, red: 120_000 };

const CURRENCY_SYMBOL = { USD: "US$", CAD: "CA$" };

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

// Colors mean usage level only: green <50%, amber 50-79%, red >=80%.
function colorForPercent(pct) {
  if (pct == null || Number.isNaN(pct)) return "gray";
  if (pct < THRESHOLDS.good) return "green";
  if (pct < THRESHOLDS.warn) return "amber";
  return "red";
}

// White below `low` (matching the Cost money accent), amber below `high`,
// red beyond it — shared by any value that stays neutral until it actually
// approaches a limit, rather than signaling "good" the way colorForPercent does.
function colorForThreshold(value, low, high) {
  if (value == null || Number.isNaN(value)) return "white";
  if (value < low) return "white";
  if (value < high) return "amber";
  return "red";
}

function colorForContextTokens(tokens) {
  return colorForThreshold(
    tokens,
    CONTEXT_TOKEN_THRESHOLDS.amber,
    CONTEXT_TOKEN_THRESHOLDS.red,
  );
}

// Like colorForPercent, but stays the neutral "white" accent instead of
// green when nowhere near the limit — only escalates to amber/red as usage
// actually approaches it.
function colorForApproachingLimit(pct) {
  return colorForThreshold(pct, THRESHOLDS.good, THRESHOLDS.warn);
}

const BAR_WIDTH = 10;

function renderBar(pct, width = BAR_WIDTH) {
  if (pct == null || Number.isNaN(pct)) return "▱".repeat(width);
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function parseShortstat(stat) {
  const ins = /(\d+)\s+insertion/.exec(stat ?? "");
  const del = /(\d+)\s+deletion/.exec(stat ?? "");
  return {
    insertions: ins ? parseInt(ins[1], 10) : 0,
    deletions: del ? parseInt(del[1], 10) : 0,
  };
}

// ---------------------------------------------------------------------------
// Account / config-dir identity
// ---------------------------------------------------------------------------

function getClaudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
}

// Shared by getAccountCacheKey (cache namespacing) and getKeychainServiceName
// (Keychain entry namespacing) — both need the same per-config-dir hash.
function getConfigDirHash() {
  return crypto
    .createHash("sha256")
    .update(getClaudeConfigDir())
    .digest("hex")
    .slice(0, 8);
}

// Labels the active profile so multiple CLAUDE_CONFIG_DIR accounts (e.g. a
// work profile) are visually distinguishable from the default. Derived from
// the config dir name rather than hardcoded, e.g. ~/.claude-work -> "WORK".
function getAccountLabel() {
  if (!process.env.CLAUDE_CONFIG_DIR) return "PERSONAL";
  const base = path.basename(getClaudeConfigDir());
  const trimmed = base.replace(/^\.?claude-?/i, "");
  return (trimmed || base).toUpperCase();
}

// ---------------------------------------------------------------------------
// Usage API response shaping
// ---------------------------------------------------------------------------

function findLimit(limits, kind) {
  return (limits ?? []).find((l) => l?.kind === kind) ?? null;
}

function normalizeUsage(raw) {
  if (!raw) return null;
  const sessionLimit = findLimit(raw.limits, "session");
  const weeklyLimit = findLimit(raw.limits, "weekly_all");

  // extra_usage.monthly_limit/used_credits are minor units (e.g. cents),
  // scaled by decimal_places — confirmed against a live API response where
  // monthly_limit: 15900, decimal_places: 2 meant $159.00, not $15,900.
  const scale = 10 ** (raw.extra_usage?.decimal_places ?? 2);
  const extraUsageLimit =
    raw.extra_usage?.monthly_limit != null
      ? raw.extra_usage.monthly_limit / scale
      : null;
  const extraUsageUsed =
    raw.extra_usage?.used_credits != null
      ? raw.extra_usage.used_credits / scale
      : null;
  const extraUsageUtilization =
    raw.extra_usage?.utilization ??
    raw.spend?.percent ??
    (extraUsageLimit ? (extraUsageUsed / extraUsageLimit) * 100 : null);

  return {
    sessionUsage: raw.five_hour?.utilization ?? sessionLimit?.percent ?? null,
    sessionResetAt: raw.five_hour?.resets_at ?? sessionLimit?.resets_at ?? null,
    weeklyUsage: raw.seven_day?.utilization ?? weeklyLimit?.percent ?? null,
    weeklyResetAt: raw.seven_day?.resets_at ?? weeklyLimit?.resets_at ?? null,
    extraUsageEnabled: raw.extra_usage?.is_enabled ?? false,
    extraUsageLimit,
    extraUsageUsed,
    extraUsageUtilization,
    extraUsageCurrency: raw.extra_usage?.currency ?? "USD",
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTokens(n) {
  if (n == null) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function formatPercent(pct) {
  return pct == null ? "n/a" : `${pct.toFixed(1)}%`;
}

function formatMoney(amount, currency) {
  if (amount == null) return "n/a";
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  return `${symbol}${amount.toFixed(2)}`;
}

function formatDuration(ms) {
  if (ms == null || ms <= 0) return "now";
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}hr`;
  if (hours > 0) return `${hours}hr ${minutes}m`;
  return `${minutes}m`;
}

function getContextWindowMetrics(data) {
  const cw = data?.context_window;
  if (!cw) return { usedTokens: 0, usedPercentage: 0 };
  const usage = cw.current_usage;
  let usedTokens = null;
  if (typeof usage === "number") {
    usedTokens = usage;
  } else if (usage && typeof usage === "object") {
    usedTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
  }
  const usedPercentage =
    cw.used_percentage ??
    (usedTokens != null && cw.context_window_size
      ? (usedTokens / cw.context_window_size) * 100
      : 0);
  return { usedTokens: usedTokens ?? 0, usedPercentage };
}

module.exports = {
  THRESHOLDS,
  CONTEXT_TOKEN_THRESHOLDS,
  CURRENCY_SYMBOL,
  colorForPercent,
  colorForThreshold,
  colorForContextTokens,
  colorForApproachingLimit,
  renderBar,
  parseShortstat,
  getClaudeConfigDir,
  getConfigDirHash,
  getAccountLabel,
  findLimit,
  normalizeUsage,
  formatTokens,
  formatPercent,
  formatMoney,
  formatDuration,
  getContextWindowMetrics,
};
