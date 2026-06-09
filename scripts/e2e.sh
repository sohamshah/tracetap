#!/usr/bin/env bash
# End-to-end validation for the trajectory platform epic.
# Exercises committed Claude/Codex captures through trajectory build, ATIF export
# + Harbor validation, analytics, redaction, index/search, diff, TUI seams, and
# the full build/typecheck/test regression sweep.

set -u -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_DIR="${TRACETAP_E2E_OUT:-$(mktemp -d /tmp/tracetap-e2e.XXXXXX)}"
mkdir -p "$OUT_DIR" "$OUT_DIR/logs" "$OUT_DIR/replay/.claude-trace" "$OUT_DIR/replay/.codex-trace"
LOG="$OUT_DIR/e2e.log"
: > "$LOG"

CLAUDE_SRC="src/trajectory/__fixtures__/claude-tooluse.jsonl"
CODEX_SRC="src/trajectory/__fixtures__/codex-tooluse.jsonl"
ERROR_SRC="src/store/__fixtures__/errored-claude.jsonl"
CLAUDE="$OUT_DIR/replay/.claude-trace/claude-tooluse.jsonl"
CODEX="$OUT_DIR/replay/.codex-trace/codex-tooluse.jsonl"
ERROR_LOG="$OUT_DIR/replay/.claude-trace/errored-claude.jsonl"
DB="$OUT_DIR/tracetap-index.db"

FAILURES=0
TOTAL=0
LAST_OUTPUT=""

log() {
  printf '%s\n' "$*" | tee -a "$LOG"
}

run_cmd() {
  LAST_OUTPUT="$OUT_DIR/logs/$1.out"
  shift
  log "\$ $*"
  "$@" >"$LAST_OUTPUT" 2>&1
}

pass() {
  TOTAL=$((TOTAL + 1))
  log "PASS step $1 — $2"
}

fail() {
  TOTAL=$((TOTAL + 1))
  FAILURES=$((FAILURES + 1))
  log "FAIL step $1 — $2"
  if [ -n "${LAST_OUTPUT:-}" ] && [ -f "$LAST_OUTPUT" ]; then
    log "  Output: $LAST_OUTPUT"
    sed 's/^/  | /' "$LAST_OUTPUT" | tail -80 | tee -a "$LOG" >/dev/null
  fi
}

step() {
  local id="$1"
  local desc="$2"
  shift 2
  log ""
  log "== Step $id: $desc =="
  if "$@"; then
    pass "$id" "$desc"
  else
    fail "$id" "$desc"
  fi
}

have_harbor_python() {
  if [ -n "${HARBOR_PYTHON:-}" ] && "$HARBOR_PYTHON" -c 'import harbor.utils.trajectory_validator' >/dev/null 2>&1; then
    printf '%s\n' "$HARBOR_PYTHON"
    return 0
  fi
  if [ -x /tmp/harbor-venv/bin/python ] && /tmp/harbor-venv/bin/python -c 'import harbor.utils.trajectory_validator' >/dev/null 2>&1; then
    printf '%s\n' /tmp/harbor-venv/bin/python
    return 0
  fi
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import harbor.utils.trajectory_validator' >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  return 1
}

assert_json_count() {
  local file="$1"
  local expr="$2"
  node - "$file" "$expr" <<'NODE'
const fs = require('fs');
const [file, expr] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const fn = new Function('data', `return (${expr});`);
if (!fn(data)) {
  console.error(`JSON assertion failed: ${expr}`);
  console.error(JSON.stringify(data, null, 2).slice(0, 4000));
  process.exit(1);
}
NODE
}

step1_replay() {
  cp "$CLAUDE_SRC" "$CLAUDE"
  cp "$CODEX_SRC" "$CODEX"
  cp "$ERROR_SRC" "$ERROR_LOG"
  node - "$CLAUDE" "$CODEX" <<'NODE'
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length !== 2) throw new Error(`${f}: expected 2 committed request/response pairs, got ${lines.length}`);
  for (const line of lines) JSON.parse(line);
}
NODE
}

step2_trajectories_and_viewers() {
  run_cmd "step2_generate_claude_html" node dist/claude-cli.js --generate-html "$CLAUDE" "$OUT_DIR/claude.html" --no-open || return 1
  run_cmd "step2_generate_codex_html" node dist/codex-cli.js --generate-html "$CODEX" "$OUT_DIR/codex.html" --no-open || return 1
  node - "$CLAUDE" "$CODEX" "$OUT_DIR/claude.html" "$OUT_DIR/codex.html" <<'NODE'
const fs = require('fs');
const { buildTrajectories } = require('./dist/trajectory/index.js');
const [claudeFile, codexFile, claudeHtml, codexHtml] = process.argv.slice(2);
function loadJsonl(f) { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
function counts(traj) {
  return {
    steps: traj.steps.length,
    toolCalls: traj.steps.reduce((n, s) => n + s.toolCalls.length, 0),
    observations: traj.steps.reduce((n, s) => n + (s.observation ? s.observation.results.length : 0), 0),
  };
}
function viewerPairCount(htmlPath, marker) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(marker);
  if (!match) throw new Error(`${htmlPath}: embedded viewer data marker missing`);
  const data = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  return data.rawPairs.length;
}
const claudePairs = loadJsonl(claudeFile);
const codexPairs = loadJsonl(codexFile);
const claudeTrajs = buildTrajectories(claudePairs);
const codexTrajs = buildTrajectories(codexPairs);
if (claudeTrajs.length !== 1 || codexTrajs.length !== 1) throw new Error('expected one trajectory per fixture');
const c = counts(claudeTrajs[0]);
const x = counts(codexTrajs[0]);
if (JSON.stringify(c) !== JSON.stringify({steps:3, toolCalls:1, observations:1})) throw new Error(`Claude trajectory counts mismatch: ${JSON.stringify(c)}`);
if (JSON.stringify(x) !== JSON.stringify({steps:3, toolCalls:1, observations:1})) throw new Error(`Codex trajectory counts mismatch: ${JSON.stringify(x)}`);
if (viewerPairCount(claudeHtml, /window\.claudeData = JSON\.parse\(decodeURIComponent\(escape\(atob\('([^']+)'\)\)\)\);/) !== claudePairs.length) throw new Error('Claude HTML embedded rawPairs count mismatch');
if (viewerPairCount(codexHtml, /window\.__CODEX_DATA_B64__ = "([^"]+)";/) !== codexPairs.length) throw new Error('Codex HTML embedded rawPairs count mismatch');
if (!fs.readFileSync(claudeHtml, 'utf8').includes('data-tracetap-stats')) throw new Error('Claude HTML missing stats header strip');
if (!fs.readFileSync(codexHtml, 'utf8').includes('data-tracetap-stats')) throw new Error('Codex HTML missing stats header strip');
NODE
}

step3_atif_harbor() {
  local harbor_py
  harbor_py="$(have_harbor_python)" || {
    echo "Harbor validator unavailable. Set HARBOR_PYTHON to a Python with harbor installed, e.g. /tmp/harbor-venv/bin/python." >&2
    return 1
  }
  run_cmd "step3_claude_atif" node dist/claude-cli.js --to-atif "$CLAUDE" "$OUT_DIR/claude.atif.json" --no-redact || return 1
  run_cmd "step3_codex_atif" node dist/codex-cli.js --to-atif "$CODEX" "$OUT_DIR/codex.atif.json" --no-redact || return 1
  run_cmd "step3_harbor_claude" "$harbor_py" -m harbor.utils.trajectory_validator "$OUT_DIR/claude.atif.json" || return 1
  grep -q "Trajectory is valid" "$LAST_OUTPUT" || return 1
  run_cmd "step3_harbor_codex" "$harbor_py" -m harbor.utils.trajectory_validator "$OUT_DIR/codex.atif.json" || return 1
  grep -q "Trajectory is valid" "$LAST_OUTPUT" || return 1
  node - "$OUT_DIR/claude.atif.json" "$OUT_DIR/codex.atif.json" <<'NODE'
const fs = require('fs');
for (const file of process.argv.slice(2)) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc.agent || !Array.isArray(doc.agent.tool_definitions) || doc.agent.tool_definitions.length < 1) {
    throw new Error(`${file}: agent.tool_definitions is empty`);
  }
  if (!doc.steps.some((s) => s.metrics && Number(s.metrics.cached_tokens) > 0)) {
    throw new Error(`${file}: no step has populated cached_tokens`);
  }
}
NODE
}

step4_analytics() {
  run_cmd "step4_claude_stats" node dist/claude-cli.js --stats "$CLAUDE" || return 1
  run_cmd "step4_codex_stats" node dist/codex-cli.js --stats "$CODEX" || return 1
  node - "$CLAUDE" "$CODEX" "$OUT_DIR/claude.html" "$OUT_DIR/codex.html" <<'NODE'
const fs = require('fs');
const [claudeFile, codexFile, claudeHtml, codexHtml] = process.argv.slice(2);
function loadStats(f) { return JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.stats.json'), 'utf8')); }
function loadPairs(f) { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
function rawUsage(pairs, agent) {
  const out = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const p of pairs) {
    if (agent === 'claude') {
      const raw = String(p.response?.body_raw || '');
      let startUsage = null;
      let deltaOutput = null;
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'message_start' && ev.message && ev.message.usage) startUsage = ev.message.usage;
          if (ev.type === 'message_delta' && ev.usage && ev.usage.output_tokens !== undefined) deltaOutput = Number(ev.usage.output_tokens || 0);
        } catch {}
      }
      if (startUsage) {
        out.input += Number(startUsage.input_tokens || 0);
        out.cacheCreation += Number(startUsage.cache_creation_input_tokens || 0);
        out.cacheRead += Number(startUsage.cache_read_input_tokens || 0);
        out.output += deltaOutput ?? Number(startUsage.output_tokens || 0);
      }
    } else {
      const raw = String(p.response?.body_raw || '');
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          const u = ev.response && ev.response.usage;
          if (!u) continue;
          out.input += Number(u.input_tokens || 0);
          out.output += Number(u.output_tokens || 0);
          out.cacheRead += Number(u.input_tokens_details?.cached_tokens || 0);
        } catch {}
      }
    }
  }
  return out;
}
for (const [file, agent] of [[claudeFile, 'claude'], [codexFile, 'codex']]) {
  const stats = loadStats(file);
  const expected = rawUsage(loadPairs(file), agent);
  const got = { input: stats.totals.totalInputTokens, output: stats.totals.totalOutputTokens, cacheCreation: stats.totals.cacheCreationTokens, cacheRead: stats.totals.cacheReadTokens };
  for (const k of ['input', 'output', 'cacheCreation', 'cacheRead']) {
    if (got[k] !== expected[k]) throw new Error(`${agent} stats ${k}: expected ${expected[k]}, got ${got[k]}`);
  }
}
for (const html of [claudeHtml, codexHtml]) {
  if (!fs.readFileSync(html, 'utf8').includes('data-tracetap-stats')) throw new Error(`${html}: missing data-tracetap-stats header strip`);
}
NODE
}

step5_redaction() {
  node - "$OUT_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const { redactBodies, countRedactions } = require('./dist/redact.js');
// Secret vectors are assembled at runtime (no credential literal is committed).
const { buildPairs, planted } = require('./src/__fixtures__/redact-secrets.gen.cjs');
const outDir = process.argv[2];
function load(name) {
  return fs.readFileSync(path.join('src/__fixtures__', name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function writeJsonl(file, pairs) {
  fs.writeFileSync(file, pairs.map((p) => JSON.stringify(p)).join('\n') + '\n');
}
const secrets = redactBodies(buildPairs(), { mode: 'standard' });
if (countRedactions(secrets) < planted.length) throw new Error('too few standard redactions in planted-secret fixture');
const secretsText = JSON.stringify(secrets);
for (const s of planted) if (secretsText.includes(s)) throw new Error(`plaintext secret survived redaction: ${s}`);
writeJsonl(path.join(outDir, 'redact-secrets.redacted.jsonl'), secrets);
const cleanRaw = fs.readFileSync('src/__fixtures__/redact-clean.jsonl', 'utf8');
const clean = redactBodies(load('redact-clean.jsonl'), { mode: 'standard' });
if (countRedactions(clean) !== 0) throw new Error('clean fixture had false-positive redactions');
const cleanOut = path.join(outDir, 'redact-clean.redacted.jsonl');
writeJsonl(cleanOut, clean);
if (fs.readFileSync(cleanOut, 'utf8') !== cleanRaw) throw new Error('clean fixture is not byte-unchanged after redaction pass');
NODE
}

search_has_hits() {
  local label="$1"
  shift
  local out="$OUT_DIR/logs/search_${label}.json"
  node dist/tracetap.js search "$@" --db "$DB" --json > "$out" 2>&1 || return 1
  assert_json_count "$out" "data.count > 0" || return 1
}

step6_index_search() {
  run_cmd "step6_index_first" node dist/tracetap.js index "$OUT_DIR/replay" --db "$DB" --json || return 1
  assert_json_count "$LAST_OUTPUT" "data.filesIndexed === 3 && data.filesSkipped === 0 && data.sessions === 3 && data.steps === 9" || return 1
  search_has_hits "query" file || return 1
  search_has_hits "tool_read" foo --tool Read || return 1
  search_has_hits "tool_shell" files --tool shell || return 1
  search_has_hits "model" foo --model opus || return 1
  search_has_hits "project" file --project "$(basename "$OUT_DIR/replay")" || return 1
  search_has_hits "agent_claude" foo --agent claude || return 1
  search_has_hits "agent_codex" file --agent codex || return 1
  search_has_hits "since" file --since 2023-11-14 || return 1
  search_has_hits "until" file --until 2023-11-14 || return 1
  search_has_hits "errored" build --errored || return 1
  search_has_hits "min_cost" file --min-cost 0 || return 1
  run_cmd "step6_index_second" node dist/tracetap.js index "$OUT_DIR/replay" --db "$DB" --json || return 1
  assert_json_count "$LAST_OUTPUT" "data.filesIndexed === 0 && data.filesSkipped === 3 && data.sessions === 0 && data.steps === 0" || return 1
}

step7_diff() {
  run_cmd "step7_diff_json" node dist/tracetap.js diff src/__fixtures__/diff-run-a.jsonl src/__fixtures__/diff-run-b.jsonl --json || return 1
  assert_json_count "$LAST_OUTPUT" "data.changed === true && data.model.changed === true && data.model.a.length === 1 && data.model.a[0] === 'claude-opus-4' && data.model.b.length === 1 && data.model.b[0] === 'claude-opus-4-1' && data.systemPrompt.addedCount === 1 && data.systemPrompt.removedCount === 1 && data.systemPrompt.ops.some(op => op.type === 'del' && op.line === 'Be concise and helpful.') && data.systemPrompt.ops.some(op => op.type === 'add' && op.line === 'Be terse and helpful.') && data.tools.added.length === 1 && data.tools.added[0] === 'Bash' && data.tools.removed.length === 0 && data.tools.changedTools.length === 1 && data.tools.changedTools[0].name === 'Write' && data.tools.unchanged.length === 1 && data.tools.unchanged[0] === 'Read' && data.shape.changed === false" || return 1
  run_cmd "step7_diff_text" node dist/tracetap.js diff src/__fixtures__/diff-run-a.jsonl src/__fixtures__/diff-run-b.jsonl || return 1
  grep -q "MODEL" "$LAST_OUTPUT" && grep -q "SYSTEM PROMPT" "$LAST_OUTPUT" && grep -q "Bash" "$LAST_OUTPUT" && grep -q "Write" "$LAST_OUTPUT" && grep -q "no changes" "$LAST_OUTPUT"
}

step8_tui() {
  [ -f VALIDATION.md ] || { echo "VALIDATION.md missing" >&2; return 1; }
  grep -q "TUI keystroke smoke walkthrough" VALIDATION.md || return 1
  for key in "open" "search" "filter" "open-in-browser" "export" "diff" "live-tail"; do
    grep -qi "$key" VALIDATION.md || { echo "VALIDATION.md missing TUI coverage word: $key" >&2; return 1; }
  done
  run_cmd "step8_explore_help" node dist/tracetap.js explore --help || return 1
  grep -q "KEYS" "$LAST_OUTPUT" || return 1
  run_cmd "step8_explore_non_tty" node dist/tracetap.js explore --db "$DB" --agent claude || return 1
  grep -q "tracetap explore:" "$LAST_OUTPUT" && grep -q "claude" "$LAST_OUTPUT" && grep -q "TTY is required" "$LAST_OUTPUT"
}

step9_regression() {
  run_cmd "step9_build" npm run build || return 1
  run_cmd "step9_typecheck" npm run typecheck || return 1
  run_cmd "step9_test" npm test || return 1
  run_cmd "step9_claude_html" node dist/claude-cli.js --generate-html "$CLAUDE" "$OUT_DIR/regression-claude.html" --no-open || return 1
  run_cmd "step9_codex_html" node dist/codex-cli.js --generate-html "$CODEX" "$OUT_DIR/regression-codex.html" --no-open || return 1
  grep -q "data-tracetap-stats" "$OUT_DIR/regression-claude.html" && grep -q "data-tracetap-stats" "$OUT_DIR/regression-codex.html" || return 1
  node - "$OUT_DIR/regression-claude.html" "$OUT_DIR/regression-codex.html" <<'NODE'
const fs = require('fs');
const [claude, codex] = process.argv.slice(2);
if (!fs.readFileSync(claude, 'utf8').includes('window.claudeData = JSON.parse')) throw new Error('Claude viewer data block missing');
if (!fs.readFileSync(codex, 'utf8').includes('window.__CODEX_DATA_B64__ = "')) throw new Error('Codex viewer data block missing');
NODE
}

log "tracetap trajectory platform e2e validation"
log "Worktree: $ROOT"
log "Branch: $(git branch --show-current 2>/dev/null || echo unknown)"
log "Output dir: $OUT_DIR"
log "Started: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# Build once before using dist-based CLIs/imports. Step 9 repeats it as the
# explicit regression gate.
run_cmd "prebuild" npm run build || { fail "pre" "initial build required for dist CLIs"; log "E2E FAILED: $FAILURES failure(s)"; exit 1; }

step 1 "Replay committed Claude and Codex fixtures through tracetap inputs" step1_replay
step 2 "Build trajectories and compare counts against generated HTML viewer payloads" step2_trajectories_and_viewers
step 3 "Export ATIF for Claude and Codex and validate both with Harbor" step3_atif_harbor
step 4 "Analytics stats totals reconcile with raw usage; HTML stats strip renders" step4_analytics
step 5 "Redaction removes planted secrets and leaves clean fixture byte-unchanged" step5_redaction
step 6 "Index/search fixtures, exercise documented filters, and verify re-index no-op" step6_index_search
step 7 "Diff intentionally different captures with exact expected changes only" step7_diff
step 8 "TUI documented keystroke smoke plus non-TTY explore seam" step8_tui
step 9 "Regression sweep: build, typecheck, full tests, Claude/Codex HTML viewers" step9_regression

log ""
log "Finished: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
log "Summary: $((TOTAL - FAILURES))/$TOTAL steps passed"
if [ "$FAILURES" -eq 0 ]; then
  log "E2E PASS"
  log "Artifacts: $OUT_DIR"
  exit 0
else
  log "E2E FAIL ($FAILURES failure(s))"
  log "Artifacts: $OUT_DIR"
  exit 1
fi
