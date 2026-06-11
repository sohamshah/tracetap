# tracetap trajectory platform validation

Final-gate validation for the trajectory platform epic (capture/replay → C1 trajectory → C2 ATIF/Harbor → C3 analytics → C4 redaction → C5 index/search → C6 diff → C7 explore/TUI → regression).

Worktree: `/Users/sohamshah/personal/tracetap-trajectory`  
Branch: `feat/trajectory-platform`

## Automated validation command

Run from the repository root:

```bash
bash scripts/e2e.sh
```

The script prints one `PASS step N` or `FAIL step N` line for each final-gate step and exits non-zero if any step fails. It leaves generated evidence under `/tmp/tracetap-e2e.*` (or `$TRACETAP_E2E_OUT` if set), including ATIF files, generated HTML reports, stats sidecars, the SQLite index, search/diff command outputs, and the full `e2e.log`.

## Harbor validator setup

Step 3 requires Harbor's ATIF validator importable as `harbor.utils.trajectory_validator`.

The validator used during this validation is available in the local throwaway venv:

```bash
/tmp/harbor-venv/bin/python -m harbor.utils.trajectory_validator <file.atif.json>
```

`scripts/e2e.sh` detects Harbor in this order:

1. `$HARBOR_PYTHON` when set and importable.
2. `/tmp/harbor-venv/bin/python` (Harbor 0.13.1 throwaway venv from earlier C2 validation).
3. `python3` when `harbor` is already installed in that interpreter.

If none are available, Step 3 fails loudly with instructions to set `HARBOR_PYTHON` to a Python interpreter that can import Harbor.

## What the automated script covers

1. **Capture/replay fixtures** — replays committed Claude and Codex request/response JSONL fixtures from:
   - `src/trajectory/__fixtures__/claude-tooluse.jsonl`
   - `src/trajectory/__fixtures__/codex-tooluse.jsonl`
2. **Trajectory construction + HTML viewer payloads** — builds C1 trajectories for both fixtures; asserts 3 steps, 1 tool call, and 1 stitched observation for each; generates the existing Claude and Codex HTML viewers and verifies their embedded viewer payloads carry the same raw-pair counts plus the stats header strip.
3. **ATIF + Harbor** — exports Claude and Codex ATIF via `--to-atif`, validates both with `python -m harbor.utils.trajectory_validator`, and spot-checks non-empty `agent.tool_definitions` plus populated per-step `cached_tokens`.
4. **Analytics** — runs `--stats` for both agents and reconciles `input`, `output`, `cacheCreation`, and `cacheRead` totals against raw usage in the fixtures; verifies generated HTML reports include `data-tracetap-stats`.
5. **Redaction** — applies standard body redaction to `src/__fixtures__/redact-secrets.jsonl`, verifies planted plaintext secrets are absent, and verifies `src/__fixtures__/redact-clean.jsonl` produces zero redactions and is byte-unchanged after the export pass.
6. **Index + search** — indexes replayed Claude/Codex sessions plus the committed errored fixture needed to exercise `--errored`; verifies a query returns hits; exercises `--tool`, `--model`, `--project`, `--agent`, `--since`, `--until`, `--errored`, and `--min-cost`; verifies re-indexing reports `0` newly indexed files.
7. **Diff** — runs `tracetap diff` on `src/__fixtures__/diff-run-a.jsonl` and `src/__fixtures__/diff-run-b.jsonl`; asserts exactly the expected model id swap, one system-prompt line change, added `Bash`, changed `Write`, unchanged `Read`, no removals, and no shape changes.
8. **Explore/TUI seam** — verifies this document contains the keystroke smoke walkthrough, `tracetap explore --help` exposes the key map, and the non-TTY fallback lists sessions rather than crashing.
9. **Regression sweep** — runs `npm run build`, `npm run typecheck`, and `npm test`; regenerates both legacy Claude and Codex HTML viewers and verifies their embedded data blocks still exist.

## TUI keystroke smoke walkthrough

The Ink UI is inherently interactive, so the exact keypress flow is documented here and the non-interactive seams are covered by `test/explore.test.mjs` plus Step 8 in `scripts/e2e.sh`.

Suggested manual smoke run after indexing fixtures:

```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/.claude-trace" "$TMP/.codex-trace"
cp src/trajectory/__fixtures__/claude-tooluse.jsonl "$TMP/.claude-trace/claude-tooluse.jsonl"
cp src/trajectory/__fixtures__/codex-tooluse.jsonl "$TMP/.codex-trace/codex-tooluse.jsonl"
cp src/store/__fixtures__/errored-claude.jsonl "$TMP/.claude-trace/errored-claude.jsonl"
node dist/tracetap.js index "$TMP" --db "$TMP/index.db"
node dist/tracetap.js explore --db "$TMP/index.db"
```

| Coverage item | Keystrokes / action | Expected result |
| --- | --- | --- |
| open | `↑`/`↓` or `j`/`k`, then `Enter` | Selected session opens; center timeline/details render. |
| search | `/`, type `file`, `Enter` | Session list narrows to matching traces. |
| filter | `f`, set agent/model/tool/errored filters, `Enter` | Structured filter applies; `Esc`/`h` returns/backtracks. |
| open-in-browser | `o` on a session with a sibling HTML report | Browser opener is invoked, or a graceful missing-report message appears. |
| export | `e` | ATIF sidecar is written via the C2 exporter and the path is shown. |
| diff | `d`, select two sessions | C6 diff output is rendered for the selected pair. |
| live-tail | `t` (or `tracetap explore --follow <file.jsonl>`) | Tail mode follows appended JSONL pairs; `q` exits cleanly. |
| quit | `q` or `Ctrl-C` | Tailer stops and Ink exits without leaving the DB open. |

### Interactive coverage caveat

The automated e2e script does **not** synthesize real terminal keypresses or launch a browser, because those actions require a human-controlled TTY/desktop. Instead:

- `test/explore.test.mjs` covers the non-interactive TUI/data seams (open-report path derivation, ATIF export, diff invocation, live-tail append handling, partial-line tolerance, trajectory loading).
- `scripts/e2e.sh` verifies `explore --help` exposes the key map and that `explore --db ...` degrades cleanly when stdout is not a TTY.
- The manual keystroke checklist above is the required human smoke path for terminal/browser behavior.

## Last verified run

Executed in this worktree on 2026-06-09T11:04Z:

```bash
bash scripts/e2e.sh && npm run build && npm run typecheck && npm test
```

Result: **PASS**.

Key output from `scripts/e2e.sh`:

```text
Output dir: /tmp/tracetap-e2e.De0Lg9
PASS step 1 — Replay committed Claude and Codex fixtures through tracetap inputs
PASS step 2 — Build trajectories and compare counts against generated HTML viewer payloads
PASS step 3 — Export ATIF for Claude and Codex and validate both with Harbor
PASS step 4 — Analytics stats totals reconcile with raw usage; HTML stats strip renders
PASS step 5 — Redaction removes planted secrets and leaves clean fixture byte-unchanged
PASS step 6 — Index/search fixtures, exercise documented filters, and verify re-index no-op
PASS step 7 — Diff intentionally different captures with exact expected changes only
PASS step 8 — TUI documented keystroke smoke plus non-TTY explore seam
PASS step 9 — Regression sweep: build, typecheck, full tests, Claude/Codex HTML viewers
Summary: 9/9 steps passed
E2E PASS
Artifacts: /tmp/tracetap-e2e.De0Lg9
```

Additional regression commands in the same verify sequence:

- `npm run build` — exit 0.
- `npm run typecheck` — exit 0.
- `npm test` — exit 0, `107/107` tests passing.

The Harbor validator invocations inside Step 3 were:

```text
/tmp/harbor-venv/bin/python -m harbor.utils.trajectory_validator /tmp/tracetap-e2e.De0Lg9/claude.atif.json
/tmp/harbor-venv/bin/python -m harbor.utils.trajectory_validator /tmp/tracetap-e2e.De0Lg9/codex.atif.json
```

Both emitted `Trajectory is valid` and the script also checked that each ATIF document includes non-empty `agent.tool_definitions` and at least one step with populated `metrics.cached_tokens`.
