#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");
const {
  colorForPercent,
  colorForContextTokens,
  colorForApproachingLimit,
  renderBar,
  parseShortstat,
  getClaudeConfigDir,
  getConfigDirHash,
  getAccountLabel,
  normalizeUsage,
  formatTokens,
  formatPercent,
  formatMoney,
  formatDuration,
  getContextWindowMetrics,
} = require("./lib");

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
// Percentage/token color thresholds, currency symbols, and other pure
// formatting rules live in lib.js instead, alongside the pure functions
// that consume them — see the Tuning section in README.md.

// Claude Code's cost.total_cost_usd is misleadingly named — it's actually in
// the account's own billing currency, which depends on the account, not the
// field name (a Canadian Pro account reports CAD; a US enterprise account
// reports USD). Override per-account via the "env" block in that profile's
// settings.json, e.g. CLAUDE_STATUSLINE_COST_CURRENCY=USD for a US account.
const RAW_COST_CURRENCY = (
  process.env.CLAUDE_STATUSLINE_COST_CURRENCY ?? "CAD"
).toUpperCase();

// Segments to omit, e.g. "session,reset,weekly" for an API-pricing account
// that has no five-hour/weekly subscription limits. Set per-account via the
// "env" block in that profile's settings.json (CLAUDE_CONFIG_DIR/settings.json)
// so it travels with the account rather than the machine.
// Valid keys: badge, model, context, git, node, session, reset, cost, weekly,
// extra, weeklyreset.
const HIDDEN_SEGMENTS = new Set(
  (process.env.CLAUDE_STATUSLINE_HIDE ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const showSegment = (name) => !HIDDEN_SEGMENTS.has(name);

// Per-segment label overrides, e.g. "badge=WORK,session=5hr,weekly=7day" to
// rename what a segment calls itself without changing its behavior. Same
// per-account settings.json "env" block as CLAUDE_STATUSLINE_HIDE.
// Valid keys: badge, context, session, reset, cost, weekly, extra, weeklyreset.
const CUSTOM_LABELS = Object.fromEntries(
  (process.env.CLAUDE_STATUSLINE_LABELS ?? "")
    .split(",")
    .map((pair) => pair.split("=").map((s) => s.trim()))
    .filter(([key, value]) => key && value)
    .map(([key, value]) => [key.toLowerCase(), value]),
);
const getLabel = (name, fallback) => CUSTOM_LABELS[name] ?? fallback;

// Namespaced per CLAUDE_CONFIG_DIR so multiple accounts (e.g. a work profile
// under a custom CLAUDE_CONFIG_DIR) don't clobber each other's cached usage
// within the TTL window.
function getAccountCacheKey() {
  return process.env.CLAUDE_CONFIG_DIR ? getConfigDirHash() : "default";
}

const CACHE_ROOT = path.join(os.homedir(), ".cache", "claude-statusline");
const USAGE_CACHE_FILE = path.join(
  CACHE_ROOT,
  getAccountCacheKey(),
  "usage.json",
);
const USAGE_CACHE_MAX_AGE_MS = 180_000; // matches ccstatusline's cache window
const USAGE_API_TIMEOUT_MS = 3000;

const FX_CACHE_FILE = path.join(CACHE_ROOT, "fxrate.json");
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
// Color / rendering helpers (terminal-specific, so they stay here rather
// than in lib.js)
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
  orange: "\x1b[38;5;208m", // non-default account badge (e.g. work profile)
  blue: "\x1b[38;5;75m", // default account badge (personal profile)
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

function getGitInfo(cwd) {
  if (runGit(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") {
    return null;
  }
  const branch =
    runGit(["symbolic-ref", "--short", "HEAD"], cwd) ||
    runGit(["rev-parse", "--short", "HEAD"], cwd) ||
    "detached";
  const unstaged = parseShortstat(runGit(["diff", "--shortstat"], cwd));
  const staged = parseShortstat(
    runGit(["diff", "--cached", "--shortstat"], cwd),
  );
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

function extractAccessToken(rawJson) {
  try {
    return JSON.parse(rawJson)?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function readTokenFromCredentialsFile() {
  try {
    const raw = fs.readFileSync(
      path.join(getClaudeConfigDir(), ".credentials.json"),
      "utf8",
    );
    return extractAccessToken(raw);
  } catch {
    return null;
  }
}

// Claude Code namespaces the Keychain entry per config dir: the default
// "Claude Code-credentials" for ~/.claude, or "Claude Code-credentials-<hash>"
// (sha256 of the resolved CLAUDE_CONFIG_DIR path, first 8 hex chars) for any
// custom config dir — otherwise every account would read the default one.
function getKeychainServiceName() {
  if (!process.env.CLAUDE_CONFIG_DIR) return "Claude Code-credentials";
  return `Claude Code-credentials-${getConfigDirHash()}`;
}

function readTokenFromKeychain() {
  try {
    // The Keychain secret is the same {claudeAiOauth:{accessToken,...}} JSON
    // blob as .credentials.json, not a bare token string.
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", getKeychainServiceName(), "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
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
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
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
            resolve(
              res.statusCode === 200 ? (parsed?.rates?.CAD ?? null) : null,
            );
          } catch {
            resolve(null);
          }
        });
      },
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const data = readStdinJson();
  const cwd = data?.workspace?.current_dir ?? data?.cwd ?? process.cwd();
  const sep = c(" │ ", "dimGray");

  // --- line 1: badge | model+effort | context | git branch+changes | node ---
  const segments1 = [];

  if (showSegment("badge")) {
    const accountBadgeColor = process.env.CLAUDE_CONFIG_DIR
      ? "orange"
      : "blue";
    const badgeText = getLabel("badge", getAccountLabel());
    segments1.push(c(badgeText, accountBadgeColor, { bold: true }));
  }

  if (showSegment("model")) {
    const modelName = data?.model?.display_name ?? "unknown";
    const effort = getThinkingEffort(data?.transcript_path);
    segments1.push(
      c(modelName, "violet", { bold: true }) +
        (effort ? c(` · ${effort}`, "violet") : ""),
    );
  }

  if (showSegment("context")) {
    const { usedTokens, usedPercentage } = getContextWindowMetrics(data);
    segments1.push(
      `${getLabel("context", "Context")} ${c(formatTokens(usedTokens), colorForContextTokens(usedTokens))} (${c(formatPercent(usedPercentage), colorForPercent(usedPercentage), { bold: true })})`,
    );
  }

  if (showSegment("git")) {
    const git = getGitInfo(cwd);
    const folderName = c(path.basename(cwd), "teal");
    const locationSegment = git
      ? `${folderName} ${c("·", "teal")} ${c(git.branch, "teal", { bold: true })} ${c("(", "gray")}${c(`+${git.insertions}`, "green")}${c(",", "gray")}${c(`-${git.deletions}`, "red")}${c(")", "gray")}`
      : `${folderName} ${c("·", "teal")} ${c("no git", "gray")}`;
    segments1.push(locationSegment);
  }

  if (showSegment("node") && fs.existsSync(path.join(cwd, "package.json"))) {
    segments1.push(c(`⬢ ${process.version}`, "green"));
  }

  // --- line 2: session bar+% | reset | cost | weekly bar+% | extra usage ---
  const usage = await getUsage();
  const segments2 = [];

  if (showSegment("session")) {
    const sessionLabel = getLabel("session", "Session");
    if (usage) {
      const sessionColor = colorForPercent(usage.sessionUsage);
      segments2.push(
        `${sessionLabel} ${c(renderBar(usage.sessionUsage), sessionColor)} ${c(formatPercent(usage.sessionUsage), sessionColor, { bold: true })}`,
      );
    } else {
      segments2.push(labeled(`${sessionLabel}: `, "n/a", "gray"));
    }
  }

  if (showSegment("reset")) {
    const resetTime = usage?.sessionResetAt
      ? formatDuration(new Date(usage.sessionResetAt).getTime() - Date.now())
      : "n/a";
    segments2.push(
      `${c(`${getLabel("reset", "Reset")} `, "gray")}${c(resetTime, "white", { bold: true })}`,
    );
  }

  if (showSegment("cost")) {
    const cost = data?.cost?.total_cost_usd ?? 0; // see RAW_COST_CURRENCY
    const usdToCad = await getUsdToCadRate();
    const otherCurrency = RAW_COST_CURRENCY === "USD" ? "CAD" : "USD";
    const convertedCost =
      usdToCad != null
        ? RAW_COST_CURRENCY === "USD"
          ? cost * usdToCad
          : cost / usdToCad
        : null;
    const costDisplay =
      convertedCost != null
        ? `${c(formatMoney(cost, RAW_COST_CURRENCY), "white", { bold: true })} ${c(`(≈${formatMoney(convertedCost, otherCurrency)})`, "gray")}`
        : c(formatMoney(cost, RAW_COST_CURRENCY), "white", { bold: true });
    segments2.push(`${c(`${getLabel("cost", "Cost")} `, "gray")}${costDisplay}`);
  }

  if (showSegment("weekly")) {
    const weeklyLabel = getLabel("weekly", "Weekly");
    if (usage) {
      const weeklyColor = colorForPercent(usage.weeklyUsage);
      segments2.push(
        `${weeklyLabel} ${c(renderBar(usage.weeklyUsage), weeklyColor)} ${c(formatPercent(usage.weeklyUsage), weeklyColor, { bold: true })}`,
      );
    } else {
      segments2.push(labeled(`${weeklyLabel}: `, "n/a", "gray"));
    }
  }

  if (showSegment("weeklyreset")) {
    const resetTime = usage?.weeklyResetAt
      ? formatDuration(new Date(usage.weeklyResetAt).getTime() - Date.now())
      : "n/a";
    segments2.push(
      `${c(`${getLabel("weeklyreset", "Weekly reset")} `, "gray")}${c(resetTime, "white", { bold: true })}`,
    );
  }

  if (showSegment("extra") && usage?.extraUsageEnabled) {
    const usedColor = colorForApproachingLimit(usage.extraUsageUtilization);
    const used = c(
      formatMoney(usage.extraUsageUsed, usage.extraUsageCurrency),
      usedColor,
      { bold: true },
    );
    const limit = c(
      formatMoney(usage.extraUsageLimit, usage.extraUsageCurrency),
      "white",
      { bold: true },
    );
    segments2.push(
      `${c(`${getLabel("extra", "Extra")} `, "gray")}${used}${c("/", "gray")}${limit}`,
    );
  }

  console.log(segments1.join(sep));
  console.log(segments2.join(sep));
}

main().catch((err) => {
  // Never let an unexpected error blank the status line entirely.
  console.error(err);
});
