"use strict";

// Exercises the actual settings.json -> env -> CLI pipeline by spawning the
// real script, rather than unit-testing its pieces in isolation (see
// lib.test.js for that). Verifies CLAUDE_STATUSLINE_HIDE/_LABELS actually
// change the printed output the way README.md documents.

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATUSLINE_PATH = path.join(__dirname, "statusline.js");

// A config dir with no credentials, so getUsageToken() returns null and the
// script never touches the Keychain or the real usage API. A plain temp dir
// (not a git repo) also keeps the git segment deterministic ("no git").
const FAKE_CONFIG_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "claude-testacct-"),
);
const FIXTURE_CWD = fs.mkdtempSync(
  path.join(os.tmpdir(), "claude-statusline-test-cwd-"),
);

after(() => {
  fs.rmSync(FAKE_CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(FIXTURE_CWD, { recursive: true, force: true });
});

// The "cost" segment always makes a live FX-rate network call when shown
// (see README's "How it works") — hidden by default here to keep tests
// hermetic and fast; formatMoney's own logic is covered in lib.test.js.
function runStatusline({ env = {}, stdin = "{}" } = {}) {
  const hide = env.CLAUDE_STATUSLINE_HIDE
    ? `${env.CLAUDE_STATUSLINE_HIDE},cost`
    : "cost";
  const result = spawnSync(process.execPath, [STATUSLINE_PATH], {
    cwd: FIXTURE_CWD,
    input: stdin,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: FAKE_CONFIG_DIR,
      ...env,
      CLAUDE_STATUSLINE_HIDE: hide,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

describe("CLAUDE_STATUSLINE_HIDE", () => {
  test("shown by default when unset", () => {
    const stdout = runStatusline();
    assert.match(stdout, /Session/);
    assert.match(stdout, /Weekly/);
    assert.match(stdout, /Reset/);
  });

  test("omits a hidden segment's label entirely", () => {
    const stdout = runStatusline({
      env: { CLAUDE_STATUSLINE_HIDE: "weeklyreset" },
    });
    assert.doesNotMatch(stdout, /Weekly reset/);
    // the plain "Weekly" bar segment should still be there
    assert.match(stdout, /Weekly/);
  });

  test("hides multiple comma-separated segments", () => {
    const stdout = runStatusline({
      env: { CLAUDE_STATUSLINE_HIDE: "session,reset,weekly,weeklyreset" },
    });
    assert.doesNotMatch(stdout, /Session/);
    assert.doesNotMatch(stdout, /\bReset\b/);
    assert.doesNotMatch(stdout, /Weekly/);
  });

  test("is case-insensitive", () => {
    const stdout = runStatusline({
      env: { CLAUDE_STATUSLINE_HIDE: "WEEKLYRESET" },
    });
    assert.doesNotMatch(stdout, /Weekly reset/);
  });
});

describe("CLAUDE_STATUSLINE_LABELS", () => {
  test("renames a segment's label without changing its behavior", () => {
    const stdout = runStatusline({
      env: { CLAUDE_STATUSLINE_LABELS: "session=5hr" },
    });
    assert.match(stdout, /5hr/);
    assert.doesNotMatch(stdout, /Session/);
  });

  test("renames the account badge", () => {
    const stdout = runStatusline({
      env: { CLAUDE_STATUSLINE_LABELS: "badge=FIELDGUIDE" },
    });
    assert.match(stdout, /FIELDGUIDE/);
  });

  test("leaves unrelated segments' default labels alone", () => {
    const stdout = runStatusline({
      env: { CLAUDE_STATUSLINE_LABELS: "session=5hr" },
    });
    assert.match(stdout, /Weekly/);
  });
});

test("account badge derives from CLAUDE_CONFIG_DIR when no override is set", () => {
  const stdout = runStatusline();
  assert.match(stdout, /TESTACCT/);
});
