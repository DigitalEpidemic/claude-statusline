# claude-statusline

A hand-rolled status line for [Claude Code](https://claude.com/claude-code),
replacing [ccstatusline](https://github.com/sirmalloc/ccstatusline) with a
single dependency-free Node script that adds threshold-based dynamic
coloring ccstatusline doesn't support.

![Screenshot of the status line output](assets/screenshot.png)

## Setup

Requires Node.js on `PATH` — no other dependencies.

1. Clone this repo somewhere on the machine.
2. Add a `statusLine` block to `~/.claude/settings.json`, pointing `command`
   at the absolute path of `statusline.js` in your clone (merge this in if
   the file already has other keys):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/claude-statusline/statusline.js",
    "padding": 0,
    "refreshInterval": 10
  }
}
```

3. Restart Claude Code (or start a new session) to pick up the change.

## What it shows

Two lines:

1. Model | thinking effort | context window usage | git branch | git changes (+ins/-del)
2. Session usage bar+% | time until session reset | session cost (+ CAD) | weekly usage bar+% | extra usage used/limit

## How it works

Most fields come straight from the JSON Claude Code pipes to the status
line command on stdin (model, cost, `context_window`, `transcript_path`,
`workspace.current_dir`). Two things aren't in that JSON and have to be
recovered separately:

- **Thinking effort** — every `type: "assistant"` entry in the session's
  transcript JSONL carries a top-level `effort` field (e.g. `"high"`).
  The script tails the transcript file and reads the most recent one.
- **Session/weekly/extra usage** — Claude Code doesn't expose this via any
  documented API. It's fetched from Anthropic's undocumented
  `GET https://api.anthropic.com/api/oauth/usage` endpoint, authenticated
  with the same OAuth access token Claude Code itself uses:
  - On macOS: `security find-generic-password -s "Claude Code-credentials" -w`
    (the Keychain entry stores the same `{claudeAiOauth:{accessToken}}` JSON
    blob as `.credentials.json` below — it's not a bare token string).
  - Fallback / other platforms: `~/.claude/.credentials.json`.

  `extra_usage.monthly_limit` / `used_credits` are minor units (typically
  cents) scaled by `extra_usage.decimal_places`, not raw dollars.

  Results are cached to `~/.cache/claude-statusline/usage.json` for 180s so
  a 10s status line refresh doesn't hammer the endpoint.

## Tuning

Everything adjustable lives in constants at the top of `statusline.js`:

- `THRESHOLDS` — the green/amber/red cutoffs (default `<50%` / `50-80%` /
  `>=80%`) shared by session %, weekly %, and extra-usage utilization.
- `CONTEXT_TOKEN_THRESHOLDS` — absolute token cutoffs (default 90k/120k) for
  coloring the context window token count.
- `CURRENCY_SYMBOL` — currency code to symbol mapping for cost/extra-usage
  amounts.
