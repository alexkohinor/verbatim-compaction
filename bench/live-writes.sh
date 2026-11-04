#!/usr/bin/env bash
# The write-heavy case (bench/case-writes): what does a session still know about
# a large file it WROTE, once compaction ran? Same live harness as live.sh —
# task, /compact and probes as three turns into one running process.
#
#   arm A  plugin from this checkout (0.2.0: input budget on, default options)
#   arm O  plugin from $BENCH_OLD_PLUGIN (0.1.0: no input budget)
#   arm B  plugin off                  (Claude Code's built-in summary)
#   arm C  plugin off, no /compact     (control, upper bound)
#   arm D  this checkout, options set to destroy (sensitivity check)
#   arm K  this checkout, options set to keep everything: the hook hands back
#          the messages it received, untouched (isolates the hook path itself)
#
# Edit gate: the session's table must pass check.mjs, else its mutation probes
# are dropped. Narration guard: probes the assistant retold are dropped.
#
# Usage: BENCH_OLD_PLUGIN=/path/to/0.1.0 bench/live-writes.sh [runs] [arms]
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
case_dir="${BENCH_CASE:-$here/case-writes}"
sandbox="${BENCH_SANDBOX:-$HOME/.cache/verbatim-compaction-bench/writes-repo}"
old_plugin="${BENCH_OLD_PLUGIN:?set BENCH_OLD_PLUGIN to a 0.1.0 checkout}"
model="${BENCH_MODEL:-sonnet}"
out="${BENCH_OUT:-$here/out-writes}"
runs="${1:-1}"
arms="${2:-A O B C D}"
mkdir -p "$out"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1

DESTROY='{"pluginConfigs":{"verbatim-compaction@inline":{"options":{"preserveRecentMessages":0,"resultBudgetChars":0,"inputBudgetChars":1,"keepUnderChars":0,"headChars":0,"tailChars":0,"minReductionRatio":0}}}}'

KEEP='{"pluginConfigs":{"verbatim-compaction@inline":{"options":{"preserveRecentMessages":100000,"resultBudgetChars":100000000,"inputBudgetChars":0,"dropSupersededCalls":false,"minReductionRatio":0}}}}'

read -r -d '' PY <<'PYEOF'
import json, os, subprocess, sys

case_dir, arm, plugin, destroy, prefix, repo, model, keep = sys.argv[1:9]
spec = json.load(open(os.path.join(case_dir, 'probes.json')))


def check():
    r = subprocess.run(['node', 'check.mjs'], cwd=repo, capture_output=True, text=True)
    return 'CHECK PASS' in r.stdout


cmd = ['claude', '-p', '--model', model, '--input-format', 'stream-json',
       '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
       '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']
if arm in ('A', 'O', 'D', 'K'):
    cmd += ['--plugin-dir', plugin]
if arm == 'D':
    cmd += ['--settings', destroy]
if arm == 'K':
    cmd += ['--settings', keep]


def message(text):
    return json.dumps({'type': 'user',
                       'message': {'role': 'user', 'content': [{'type': 'text', 'text': text}]}}) + '\n'


proc = subprocess.Popen(cmd, cwd=repo, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL, text=True, bufsize=1)
narration, results, compact_note = [], [], ''
edited = False
turns = [spec['task']] + ([] if arm == 'C' else ['/compact']) + [spec['probe_prompt']]
try:
    for index, turn in enumerate(turns):
        proc.stdin.write(message(turn))
        proc.stdin.flush()
        while True:
            line = proc.stdout.readline()
            if not line:
                raise SystemExit('session ended early')
            try:
                event = json.loads(line)
            except Exception:
                continue
            if index == 0 and event.get('type') == 'assistant':
                for block in (event.get('message') or {}).get('content') or []:
                    if isinstance(block, dict) and block.get('type') == 'text':
                        narration.append(block.get('text') or '')
            if 'verbatim-compaction' in line and not compact_note:
                compact_note = line[:400]
            if event.get('type') == 'result':
                results.append(event.get('result', ''))
                break
        if index == 0:
            edited = check()
finally:
    try:
        proc.stdin.close()
        proc.wait(timeout=30)
    except Exception:
        proc.kill()

open(f'{prefix}.txt', 'w').write(results[-1] if results else '')
open(f'{prefix}-narration.txt', 'w').write('\n'.join(narration))
json.dump({'arm': arm, 'edited': edited, 'turns': len(results), 'model': model,
           'compact_note': compact_note}, open(f'{prefix}.meta.json', 'w'))
print(f'    arm {arm}: {len(results)} turns, table passes check: {edited}, '
      f'answer {len(results[-1] if results else "")} bytes')
PYEOF

for run in $(seq 1 "$runs"); do
  for arm in $arms; do
    plugin="$root"; [ "$arm" = O ] && plugin="$old_plugin"
    echo "=== run $run arm $arm"
    "$case_dir/setup.sh" "$sandbox" >/dev/null
    timeout 1500 python3 -c "$PY" "$case_dir" "$arm" "$plugin" "$DESTROY" "$out/run${run}-arm${arm}" "$sandbox" "$model" "$KEEP"
  done
done

python3 "$here/score.py" "$case_dir/probes.json" "$out"
