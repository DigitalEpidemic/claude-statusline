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

// Percent thresholds shared by session/weekly/context/extra-usage bars.
// < GOOD -> green, < WARN -> yellow, >= WARN -> red.
const THRESHOLDS = { good: 50, warn: 80 };

const EFFORT_COLOR = {
  low: "green",
  medium: "cyan",
  high: "yellow",
  xhigh: "orange",
  max: "red",
};

const CURRENCY_SYMBOL = { USD: "$", CAD: "CA$", EUR: "€", GBP: "£" };

const USAGE_CACHE_DIR = path.join(os.homedir(), ".cache", "claude-statusline");
const USAGE_CACHE_FILE = path.join(USAGE_CACHE_DIR, "usage.json");
const USAGE_CACHE_MAX_AGE_MS = 180_000; // matches ccstatusline's cache window
const USAGE_API_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[97m",
  gray: "\x1b[90m",
  orange: "\x1b[38;5;208m",
};

function c(text, color, { dim } = {}) {
  const code = ANSI[color] ?? "";
  const dimCode = dim ? ANSI.dim : "";
  return `${dimCode}${code}${text}${ANSI.reset}`;
}

function colorForPercent(pct) {
  if (pct == null || Number.isNaN(pct)) return "gray";
  if (pct < THRESHOLDS.good) return "green";
  if (pct < THRESHOLDS.warn) return "yellow";
  return "red";
}

const BAR_WIDTH = 10;

function renderBar(pct, width = BAR_WIDTH) {
  if (pct == null || Number.isNaN(pct)) return "░".repeat(width);
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
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

function readUsageCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, "utf8"));
    return raw;
  } catch {
    return null;
  }
}

function writeUsageCache(data) {
  try {
    fs.mkdirSync(USAGE_CACHE_DIR, { recursive: true });
    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify({ data, cachedAt: Date.now() }));
  } catch {
    // best-effort cache; ignore write failures
  }
}

async function getUsage() {
  const cached = readUsageCache();
  if (cached && Date.now() - cached.cachedAt < USAGE_CACHE_MAX_AGE_MS) {
    return cached.data;
  }

  const token = getUsageToken();
  if (!token) return cached?.data ?? null;

  const raw = await fetchUsageFromApi(token);
  const normalized = normalizeUsage(raw);
  if (normalized) {
    writeUsageCache(normalized);
    return normalized;
  }
  return cached?.data ?? null; // stale-while-error
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

  // --- line 1: model | thinking | context | git branch | git changes ---
  const modelName = data?.model?.display_name ?? "unknown";
  const segments1 = [c(modelName, "cyan")];

  const effort = getThinkingEffort(data?.transcript_path);
  if (effort) {
    segments1.push(c(`Thinking: ${effort}`, EFFORT_COLOR[effort] ?? "gray"));
  }

  const { usedTokens, usedPercentage } = getContextWindowMetrics(data);
  segments1.push(
    c(`Ctx: ${formatTokens(usedTokens)} (${formatPercent(usedPercentage)})`, colorForPercent(usedPercentage))
  );

  const git = getGitInfo(cwd);
  if (git) {
    segments1.push(c(git.branch, "magenta"));
    segments1.push(
      `(${c(`+${git.insertions}`, "green")},${c(`-${git.deletions}`, "red")})`
    );
  }

  // --- line 2: session usage+bar | reset | cost | weekly | overage ---
  const usage = await getUsage();
  const segments2 = [];
  if (usage) {
    const sessionColor = colorForPercent(usage.sessionUsage);
    segments2.push(
      c(
        `Session: ${renderBar(usage.sessionUsage)} ${formatPercent(usage.sessionUsage)}`,
        sessionColor
      )
    );
    if (usage.sessionResetAt) {
      const remaining = new Date(usage.sessionResetAt).getTime() - Date.now();
      segments2.push(c(`Reset: ${formatDuration(remaining)}`, "white", { dim: true }));
    }
  } else {
    segments2.push(c("Session: n/a", "gray"));
  }
  const cost = data?.cost?.total_cost_usd;
  segments2.push(c(`Cost: $${(cost ?? 0).toFixed(2)}`, "green", { dim: true }));

  if (usage) {
    segments2.push(
      c(`Weekly: ${formatPercent(usage.weeklyUsage)}`, colorForPercent(usage.weeklyUsage))
    );
    if (usage.extraUsageEnabled) {
      segments2.push(
        c(
          `Overage Used: ${formatMoney(usage.extraUsageUsed, usage.extraUsageCurrency)}`,
          colorForPercent(usage.extraUsageUtilization)
        )
      );
      const remaining =
        usage.extraUsageLimit != null && usage.extraUsageUsed != null
          ? usage.extraUsageLimit - usage.extraUsageUsed
          : null;
      // Colored by the same utilization% as "Used" — little left (high
      // utilization) should read as alarming, plenty left should read green.
      segments2.push(
        c(
          `Overage Left: ${formatMoney(remaining, usage.extraUsageCurrency)}`,
          colorForPercent(usage.extraUsageUtilization),
          { dim: true }
        )
      );
    }
  } else {
    segments2.push(c("Weekly: n/a", "gray"));
  }

  const sep = c(" | ", "gray");
  console.log(segments1.join(sep));
  console.log(segments2.join(sep));
}

main();
