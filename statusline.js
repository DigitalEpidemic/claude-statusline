#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// Percent thresholds shared by session/weekly/extra-usage bars.
// < GOOD -> green, < WARN -> yellow, >= WARN -> red.
const THRESHOLDS = { good: 50, warn: 80 };

// Absolute token thresholds for the context token count, anchored to the
// ~120k "smart zone" limit past which response quality noticeably degrades
// — separate from THRESHOLDS since it's not a percentage of the raw window.
const CONTEXT_TOKEN_THRESHOLDS = { amber: 90_000, red: 120_000 };

const CURRENCY_SYMBOL = { USD: "US$", CAD: "CA$", EUR: "€", GBP: "£" };

const USAGE_CACHE_DIR = path.join(os.homedir(), ".cache", "claude-statusline");
const USAGE_CACHE_FILE = path.join(USAGE_CACHE_DIR, "usage.json");
const USAGE_CACHE_MAX_AGE_MS = 180_000; // matches ccstatusline's cache window
const USAGE_API_TIMEOUT_MS = 3000;

const FX_CACHE_FILE = path.join(USAGE_CACHE_DIR, "fxrate.json");
const FX_CACHE_MAX_AGE_MS = 86_400_000; // 24h — exchange rates don't need to be fresher than that
const FX_API_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Generic TTL cache (shared by the usage and FX-rate lookups below)
// ---------------------------------------------------------------------------

function readCacheFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCacheFile(file, data) {
  try {
    fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ data, cachedAt: Date.now() }));
  } catch {
    // best-effort cache; ignore write failures
  }
}

// Returns cached data if younger than maxAgeMs, otherwise calls fetchFn and
// caches a non-null result. Falls back to stale cached data on fetch failure.
async function withCache(file, maxAgeMs, fetchFn) {
  const cached = readCacheFile(file);
  if (cached && Date.now() - cached.cachedAt < maxAgeMs) {
    return cached.data;
  }
  const fresh = await fetchFn();
  if (fresh != null) {
    writeCacheFile(file, fresh);
    return fresh;
  }
  return cached?.data ?? null; // stale-while-error
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

// 256-color palette matching the oklch values from the "1c" design mock.
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  violet: "\x1b[38;5;140m", // model
  teal: "\x1b[38;5;73m", // branch
  green: "\x1b[38;5;114m", // low usage / diff additions
  amber: "\x1b[38;5;179m", // mid usage
  red: "\x1b[38;5;167m", // high usage / diff deletions
  gray: "\x1b[38;5;245m", // secondary text
  dimGray: "\x1b[38;5;238m", // separators
  white: "\x1b[38;5;252m", // fixed bold accent for money values (Cost, Extra) — soft, not pure white
};

function c(text, color, { dim, bold } = {}) {
  const code = ANSI[color] ?? "";
  const boldCode = bold ? ANSI.bold : "";
  const dimCode = dim ? ANSI.dim : "";
  return `${boldCode}${dimCode}${code}${text}${ANSI.reset}`;
}

// A "Label: value" pair where the label stays a neutral gray and only the
// value takes on the dynamic/threshold color.
function labeled(label, value, color, opts) {
  return `${c(label, "gray")}${c(value, color, opts)}`;
}

// Colors mean usage level only: green <50%, amber 50-79%, red >=80%.
function colorForPercent(pct) {
  if (pct == null || Number.isNaN(pct)) return "gray";
  if (pct < THRESHOLDS.good) return "green";
  if (pct < THRESHOLDS.warn) return "amber";
  return "red";
}

// Gray below the amber start, amber up to the 120k smart-zone limit, red past it.
function colorForContextTokens(tokens) {
  if (tokens == null) return "gray";
  if (tokens < CONTEXT_TOKEN_THRESHOLDS.amber) return "gray";
  if (tokens < CONTEXT_TOKEN_THRESHOLDS.red) return "amber";
  return "red";
}

// Like colorForPercent, but stays the neutral "white" accent instead of
// green when nowhere near the limit — only escalates to amber/red as usage
// actually approaches it.
function colorForApproachingLimit(pct) {
  if (pct == null || Number.isNaN(pct)) return "white";
  if (pct < THRESHOLDS.good) return "white";
  if (pct < THRESHOLDS.warn) return "amber";
  return "red";
}

const BAR_WIDTH = 10;

function renderBar(pct, width = BAR_WIDTH) {
  if (pct == null || Number.isNaN(pct)) return "▱".repeat(width);
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

// ---------------------------------------------------------------------------
// stdin (Claude Code status JSON)
// ---------------------------------------------------------------------------

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function runGit(args, cwd) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
  } catch {
    return null;
  }
}

function parseShortstat(stat) {
  const ins = /(\d+)\s+insertion/.exec(stat ?? "");
  const del = /(\d+)\s+deletion/.exec(stat ?? "");
  return {
    insertions: ins ? parseInt(ins[1], 10) : 0,
    deletions: del ? parseInt(del[1], 10) : 0,
  };
}

function getGitInfo(cwd) {
  if (runGit(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") {
    return null;
  }
  const branch = runGit(["symbolic-ref", "--short", "HEAD"], cwd) ||
    runGit(["rev-parse", "--short", "HEAD"], cwd) || "detached";
  const unstaged = parseShortstat(runGit(["diff", "--shortstat"], cwd));
  const staged = parseShortstat(runGit(["diff", "--cached", "--shortstat"], cwd));
  return {
    branch,
    insertions: unstaged.insertions + staged.insertions,
    deletions: unstaged.deletions + staged.deletions,
  };
}

// ---------------------------------------------------------------------------
// Thinking effort (recovered from the transcript, not in the status JSON)
// ---------------------------------------------------------------------------

const TAIL_BYTES = 200_000;

function readTail(filePath, maxBytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Every assistant transcript entry carries its effort level directly as a
// top-level field (e.g. {"type":"assistant","effort":"high",...}) — just
// read the most recent one, no need to parse slash-command echoes.
function getThinkingEffort(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  let text;
  try {
    text = readTail(transcriptPath, TAIL_BYTES);
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // tail read may have truncated the first line mid-JSON
    }
    if (entry.type === "assistant" && typeof entry.effort === "string") {
      return entry.effort.toLowerCase();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Usage API (undocumented) — mirrors ccstatusline's token discovery + endpoint
// ---------------------------------------------------------------------------

function getClaudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
}

function extractAccessToken(rawJson) {
  try {
    return JSON.parse(rawJson)?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function readTokenFromCredentialsFile() {
  try {
    const raw = fs.readFileSync(path.join(getClaudeConfigDir(), ".credentials.json"), "utf8");
    return extractAccessToken(raw);
  } catch {
    return null;
  }
}

function readTokenFromKeychain() {
  try {
    // The Keychain secret is the same {claudeAiOauth:{accessToken,...}} JSON
    // blob as .credentials.json, not a bare token string.
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return extractAccessToken(raw);
  } catch {
    return null;
  }
}

function getUsageToken() {
  if (process.platform === "darwin") {
    return readTokenFromKeychain() ?? readTokenFromCredentialsFile();
  }
  return readTokenFromCredentialsFile();
}

function fetchUsageFromApi(token) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/api/oauth/usage",
        method: "GET",
        timeout: USAGE_API_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode === 200 && body) {
            try {
              resolve(JSON.parse(body));
              return;
            } catch {
              resolve(null);
              return;
            }
          }
          resolve(null);
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

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
    raw.extra_usage?.monthly_limit != null ? raw.extra_usage.monthly_limit / scale : null;
  const extraUsageUsed =
    raw.extra_usage?.used_credits != null ? raw.extra_usage.used_credits / scale : null;
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

async function getUsage() {
  return withCache(USAGE_CACHE_FILE, USAGE_CACHE_MAX_AGE_MS, async () => {
    const token = getUsageToken();
    if (!token) return null;
    return normalizeUsage(await fetchUsageFromApi(token));
  });
}

// ---------------------------------------------------------------------------
// FX rate (for showing Cost, which Claude Code only reports in USD, in CAD too)
// ---------------------------------------------------------------------------

function fetchUsdToCadRate() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "open.er-api.com",
        path: "/v6/latest/USD",
        method: "GET",
        timeout: FX_API_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve(res.statusCode === 200 ? parsed?.rates?.CAD ?? null : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

async function getUsdToCadRate() {
  return withCache(FX_CACHE_FILE, FX_CACHE_MAX_AGE_MS, fetchUsdToCadRate);
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
  if (!cw) return { usedTokens: null, usedPercentage: null };
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
      : null);
  return { usedTokens, usedPercentage };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const data = readStdinJson();
  const cwd = data?.workspace?.current_dir ?? data?.cwd ?? process.cwd();
  const sep = c(" │ ", "dimGray");

  // --- line 1: model+effort | context | git branch+changes ---
  const modelName = data?.model?.display_name ?? "unknown";
  const effort = getThinkingEffort(data?.transcript_path);
  const modelSegment =
    c(modelName, "violet", { bold: true }) + (effort ? c(` · ${effort}`, "gray") : "");
  const segments1 = [modelSegment];

  const { usedTokens, usedPercentage } = getContextWindowMetrics(data);
  segments1.push(
    `Ctx ${c(formatTokens(usedTokens), colorForContextTokens(usedTokens))} (${c(formatPercent(usedPercentage), colorForPercent(usedPercentage), { bold: true })})`
  );

  const git = getGitInfo(cwd);
  const folderName = c(path.basename(cwd), "gray");
  const locationSegment = git
    ? `${folderName} ${c("·", "gray")} ${c(git.branch, "teal", { bold: true })} ${c("(", "gray")}${c(`+${git.insertions}`, "green")}${c(",", "gray")}${c(`-${git.deletions}`, "red")}${c(")", "gray")}`
    : folderName;
  segments1.push(locationSegment);

  // --- line 2: session bar+% | reset+cost | weekly bar+% | extra usage ---
  const usage = await getUsage();
  const segments2 = [];
  if (usage) {
    const sessionColor = colorForPercent(usage.sessionUsage);
    segments2.push(
      `Session ${c(renderBar(usage.sessionUsage), sessionColor)} ${c(formatPercent(usage.sessionUsage), sessionColor, { bold: true })}`
    );
  } else {
    segments2.push(labeled("Session: ", "n/a", "gray"));
  }

  const cost = data?.cost?.total_cost_usd ?? 0;
  const usdToCad = await getUsdToCadRate();
  const costDisplay =
    usdToCad != null
      ? `${c(formatMoney(cost, "USD"), "white", { bold: true })} ${c(`(≈${formatMoney(cost * usdToCad, "CAD")})`, "gray")}`
      : c(formatMoney(cost, "USD"), "white", { bold: true });
  const resetTime = usage?.sessionResetAt
    ? formatDuration(new Date(usage.sessionResetAt).getTime() - Date.now())
    : "n/a";
  segments2.push(
    `${c("Reset ", "gray")}${c(resetTime, "white", { bold: true })}${c(" │ ", "gray")}${c("Cost ", "gray")}${costDisplay}`
  );

  if (usage) {
    const weeklyColor = colorForPercent(usage.weeklyUsage);
    segments2.push(
      `Weekly ${c(renderBar(usage.weeklyUsage), weeklyColor)} ${c(formatPercent(usage.weeklyUsage), weeklyColor, { bold: true })}`
    );
    if (usage.extraUsageEnabled) {
      const usedColor = colorForApproachingLimit(usage.extraUsageUtilization);
      const used = c(formatMoney(usage.extraUsageUsed, usage.extraUsageCurrency), usedColor, {
        bold: true,
      });
      const limit = c(formatMoney(usage.extraUsageLimit, usage.extraUsageCurrency), "white", {
        bold: true,
      });
      segments2.push(`${c("Extra ", "gray")}${used}${c("/", "gray")}${limit}`);
    }
  } else {
    segments2.push(labeled("Weekly: ", "n/a", "gray"));
  }

  console.log(segments1.join(sep));
  console.log(segments2.join(sep));
}

main();
