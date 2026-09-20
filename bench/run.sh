#!/usr/bin/env bash
# A/B/C benchmark: does the assistant still know what it needs after compaction?
#
#   base session (does real work in a sandbox repo)
#     ├── fork → /compact with this plugin      → arm A (verbatim rules)
#     ├── fork → /compact without the plugin    → arm B (built-in summary)
#     ├── fork → no compaction                  → arm C (control, upper bound)
#     └── fork → /compact, rules set to destroy → arm D (sensitivity check: this
#                                                  arm MUST lose probes, or the
#                                                  probes measure nothing)
#
# Each arm is then asked the same probes with every tool disabled, so the
# answers can only come from what survived in its context.
#
# Usage: bench/run.sh [runs]     (default 1)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
case_dir="$here/case-parser"
out="$here/out"
runs="${1:-1}"
mkdir -p "$out"

export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
NO_TOOLS='Read Grep Glob Edit Write MultiEdit Bash WebFetch WebSearch Task TodoWrite NotebookEdit'

task="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["task"])' "$case_dir/probes.json")"
probe="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["probe_prompt"])' "$case_dir/probes.json")"

sid() { python3 -c 'import json,sys; print(json.load(sys.stdin).get("session_id",""))'; }
answer() { python3 -c 'import json,sys; print(json.load(sys.stdin).get("result",""))'; }

for run in $(seq 1 "$runs"); do
  echo "=== run $run: building the sandbox and doing the work"
  "$case_dir/setup.sh" >/dev/null
  cd "$case_dir/repo"

  base=$(timeout 900 claude -p "$task" \
    --allowedTools Read Grep Glob Edit Bash \
    --output-format json 2>/dev/null | sid)
  echo "    base session $base"
  [ -z "$base" ] && { echo "    base session failed"; continue; }

  # What the assistant said in its own words before any compaction. A probe whose
  # answer is in here is answerable without a single byte of tool output, so the
  # scorer drops it instead of counting it as recall.
  proj="/root/.claude/projects/$(pwd | sed 's#[/.]#-#g')"
  python3 - "$proj/$base.jsonl" > "$out/run${run}-narration.txt" <<'NARR'
import json, sys
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    try:
        o = json.loads(line)
    except Exception:
        continue
    if o.get('type') != 'assistant':
        continue
    c = (o.get('message') or {}).get('content')
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get('type') in ('text', 'thinking'):
                print(b.get('text') or b.get('thinking') or '')
NARR

  destroy='{"pluginConfigs":{"verbatim-compaction@inline":{"options":{"preserveRecentMessages":0,"resultBudgetChars":0,"keepUnderChars":0,"headChars":0,"tailChars":0,"minReductionRatio":0}}}}'

  for arm in A B C D; do
    settings=()
    case "$arm" in
      A) plugin=(--plugin-dir "$root"); compact=1 ;;
      B) plugin=();                     compact=1 ;;
      C) plugin=();                     compact=0 ;;
      D) plugin=(--plugin-dir "$root"); compact=1; settings=(--settings "$destroy") ;;
    esac

    if [ "$compact" = 1 ]; then
      fork=$(timeout 900 claude -p --resume "$base" --fork-session "/compact" \
        "${plugin[@]}" ${settings[@]+"${settings[@]}"} --output-format json 2>/dev/null | sid)
    else
      fork=$(timeout 900 claude -p --resume "$base" --fork-session \
        "Reply with the single word READY." --output-format json 2>/dev/null | sid)
    fi
    echo "    arm $arm session $fork"
    [ -z "$fork" ] && { echo "    arm $arm failed"; continue; }

    timeout 900 claude -p --resume "$fork" "$probe" \
      --disallowedTools $NO_TOOLS --output-format json 2>/dev/null \
      | answer > "$out/run${run}-arm${arm}.txt"
    echo "    arm $arm answered ($(wc -c <"$out/run${run}-arm${arm}.txt") bytes)"
  done
  cd "$root"
done

python3 "$here/score.py" "$case_dir/probes.json" "$out"
