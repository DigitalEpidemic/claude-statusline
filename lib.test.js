"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const lib = require("./lib");

describe("colorForPercent", () => {
  test("green below the good threshold", () => {
    assert.equal(lib.colorForPercent(0), "green");
    assert.equal(lib.colorForPercent(49.9), "green");
  });
  test("amber between good and warn", () => {
    assert.equal(lib.colorForPercent(50), "amber");
    assert.equal(lib.colorForPercent(79.9), "amber");
  });
  test("red at or above warn", () => {
    assert.equal(lib.colorForPercent(80), "red");
    assert.equal(lib.colorForPercent(150), "red");
  });
  test("gray for missing/invalid input", () => {
    assert.equal(lib.colorForPercent(null), "gray");
    assert.equal(lib.colorForPercent(undefined), "gray");
    assert.equal(lib.colorForPercent(NaN), "gray");
  });
});

describe("colorForThreshold", () => {
  test("white below low", () => {
    assert.equal(lib.colorForThreshold(0, 80_000, 120_000), "white");
  });
  test("amber between low and high", () => {
    assert.equal(lib.colorForThreshold(80_000, 80_000, 120_000), "amber");
  });
  test("red at or above high", () => {
    assert.equal(lib.colorForThreshold(120_000, 80_000, 120_000), "red");
  });
  test("white for missing/invalid input", () => {
    assert.equal(lib.colorForThreshold(null, 1, 2), "white");
    assert.equal(lib.colorForThreshold(NaN, 1, 2), "white");
  });
});

describe("renderBar", () => {
  test("empty bar at 0%", () => {
    assert.equal(lib.renderBar(0), "▱▱▱▱▱▱▱▱▱▱");
  });
  test("full bar at 100%", () => {
    assert.equal(lib.renderBar(100), "▰▰▰▰▰▰▰▰▰▰");
  });
  test("rounds partial fill", () => {
    assert.equal(lib.renderBar(46), "▰▰▰▰▰▱▱▱▱▱");
  });
  test("clamps out-of-range percentages", () => {
    assert.equal(lib.renderBar(150), "▰▰▰▰▰▰▰▰▰▰");
    assert.equal(lib.renderBar(-10), "▱▱▱▱▱▱▱▱▱▱");
  });
  test("empty bar for missing/invalid input", () => {
    assert.equal(lib.renderBar(null), "▱▱▱▱▱▱▱▱▱▱");
    assert.equal(lib.renderBar(NaN), "▱▱▱▱▱▱▱▱▱▱");
  });
});

describe("parseShortstat", () => {
  test("parses insertions and deletions", () => {
    assert.deepEqual(
      lib.parseShortstat("2 files changed, 26 insertions(+), 7 deletions(-)"),
      { insertions: 26, deletions: 7 },
    );
  });
  test("defaults missing counts to 0", () => {
    assert.deepEqual(lib.parseShortstat("1 file changed, 5 insertions(+)"), {
      insertions: 5,
      deletions: 0,
    });
  });
  test("handles empty/null input", () => {
    assert.deepEqual(lib.parseShortstat(null), { insertions: 0, deletions: 0 });
    assert.deepEqual(lib.parseShortstat(""), { insertions: 0, deletions: 0 });
  });
});

describe("formatTokens", () => {
  test("raw count under 1000", () => {
    assert.equal(lib.formatTokens(999), "999");
  });
  test("abbreviates thousands with one decimal", () => {
    assert.equal(lib.formatTokens(1000), "1.0k");
    assert.equal(lib.formatTokens(84_500), "84.5k");
  });
  test("defaults null to 0", () => {
    assert.equal(lib.formatTokens(null), "0");
  });
});

describe("formatPercent", () => {
  test("formats with one decimal", () => {
    assert.equal(lib.formatPercent(24), "24.0%");
    assert.equal(lib.formatPercent(45.67), "45.7%");
  });
  test("n/a for null", () => {
    assert.equal(lib.formatPercent(null), "n/a");
  });
});

describe("formatMoney", () => {
  test("known currency symbols", () => {
    assert.equal(lib.formatMoney(1.5, "USD"), "US$1.50");
    assert.equal(lib.formatMoney(1.5, "CAD"), "CA$1.50");
  });
  test("falls back to currency code for unknown currencies", () => {
    assert.equal(lib.formatMoney(1.5, "GBP"), "GBP 1.50");
  });
  test("n/a for null amount", () => {
    assert.equal(lib.formatMoney(null, "USD"), "n/a");
  });
});

describe("formatDuration", () => {
  test("now for zero/negative/null", () => {
    assert.equal(lib.formatDuration(0), "now");
    assert.equal(lib.formatDuration(-1), "now");
    assert.equal(lib.formatDuration(null), "now");
  });
  test("minutes only under an hour", () => {
    assert.equal(lib.formatDuration(45 * 60_000), "45m");
  });
  test("hours and minutes under a day", () => {
    assert.equal(lib.formatDuration(90 * 60_000), "1hr 30m");
  });
  test("days and hours at/beyond a day", () => {
    assert.equal(
      lib.formatDuration((2 * 24 * 60 + 21 * 60) * 60_000),
      "2d 21hr",
    );
  });
});

describe("getContextWindowMetrics", () => {
  test("zeroed defaults when context_window is absent", () => {
    assert.deepEqual(lib.getContextWindowMetrics({}), {
      usedTokens: 0,
      usedPercentage: 0,
    });
  });
  test("numeric current_usage", () => {
    const result = lib.getContextWindowMetrics({
      context_window: { current_usage: 1000, context_window_size: 200_000 },
    });
    assert.equal(result.usedTokens, 1000);
    assert.equal(result.usedPercentage, 0.5);
  });
  test("object current_usage sums the three token fields", () => {
    const result = lib.getContextWindowMetrics({
      context_window: {
        current_usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 25,
        },
        context_window_size: 175,
      },
    });
    assert.equal(result.usedTokens, 175);
    assert.equal(result.usedPercentage, 100);
  });
  test("prefers explicit used_percentage over the derived value", () => {
    const result = lib.getContextWindowMetrics({
      context_window: {
        current_usage: 1000,
        context_window_size: 200_000,
        used_percentage: 42,
      },
    });
    assert.equal(result.usedPercentage, 42);
  });
});

describe("findLimit", () => {
  test("finds a limit by kind", () => {
    const limits = [{ kind: "session", percent: 24 }, { kind: "weekly_all", percent: 46 }];
    assert.deepEqual(lib.findLimit(limits, "weekly_all"), {
      kind: "weekly_all",
      percent: 46,
    });
  });
  test("null when not found or limits missing", () => {
    assert.equal(lib.findLimit([], "session"), null);
    assert.equal(lib.findLimit(undefined, "session"), null);
  });
});

describe("normalizeUsage", () => {
  test("null passthrough", () => {
    assert.equal(lib.normalizeUsage(null), null);
  });
  test("prefers five_hour/seven_day over limits[], scales extra_usage minor units", () => {
    const result = lib.normalizeUsage({
      five_hour: { utilization: 24, resets_at: "2026-08-13T20:00:00Z" },
      seven_day: { utilization: 46, resets_at: "2026-08-16T00:00:00Z" },
      limits: [
        { kind: "session", percent: 99, resets_at: "wrong" },
        { kind: "weekly_all", percent: 99, resets_at: "wrong" },
      ],
      extra_usage: {
        is_enabled: true,
        monthly_limit: 15900,
        used_credits: 4348,
        decimal_places: 2,
        currency: "CAD",
      },
    });
    assert.equal(result.sessionUsage, 24);
    assert.equal(result.sessionResetAt, "2026-08-13T20:00:00Z");
    assert.equal(result.weeklyUsage, 46);
    assert.equal(result.weeklyResetAt, "2026-08-16T00:00:00Z");
    assert.equal(result.extraUsageEnabled, true);
    assert.equal(result.extraUsageLimit, 159);
    assert.equal(result.extraUsageUsed, 43.48);
    assert.equal(result.extraUsageCurrency, "CAD");
  });
  test("falls back to limits[] when five_hour/seven_day are absent", () => {
    const result = lib.normalizeUsage({
      limits: [
        { kind: "session", percent: 12, resets_at: "a" },
        { kind: "weekly_all", percent: 34, resets_at: "b" },
      ],
    });
    assert.equal(result.sessionUsage, 12);
    assert.equal(result.sessionResetAt, "a");
    assert.equal(result.weeklyUsage, 34);
    assert.equal(result.weeklyResetAt, "b");
    assert.equal(result.extraUsageEnabled, false);
  });
  test("derives extraUsageUtilization from used/limit when not reported directly", () => {
    const result = lib.normalizeUsage({
      extra_usage: {
        is_enabled: true,
        monthly_limit: 10000,
        used_credits: 2500,
        decimal_places: 2,
      },
    });
    assert.equal(result.extraUsageUtilization, 25);
  });
});

describe("getAccountLabel", () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  test("PERSONAL when no CLAUDE_CONFIG_DIR is set", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(lib.getAccountLabel(), "PERSONAL");
  });
  test("derives a label from a custom config dir", () => {
    process.env.CLAUDE_CONFIG_DIR = "/Users/test/.claude-work";
    assert.equal(lib.getAccountLabel(), "WORK");
  });
  test.after(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  });
});

describe("getConfigDirHash", () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  test("is deterministic for the same config dir", () => {
    process.env.CLAUDE_CONFIG_DIR = "/Users/test/.claude-work";
    const first = lib.getConfigDirHash();
    const second = lib.getConfigDirHash();
    assert.equal(first, second);
    assert.equal(first.length, 8);
  });
  test("differs across config dirs", () => {
    process.env.CLAUDE_CONFIG_DIR = "/Users/test/.claude-work";
    const work = lib.getConfigDirHash();
    process.env.CLAUDE_CONFIG_DIR = "/Users/test/.claude-other";
    const other = lib.getConfigDirHash();
    assert.notEqual(work, other);
  });
  test.after(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  });
});
