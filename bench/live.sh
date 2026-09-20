#!/usr/bin/env bash
# One live session per arm: task → /compact → probes, all in the same process.
#
# The earlier fork+resume harness could not measure anything: a resumed session
# reloads its log, so a hook's compaction did not reach the probe turn and the
# treated arms scored exactly like the untreated control. Here every turn is
# sent over stream-json into one running session, so the probes are answered
# from the context the compaction actually left behind.
#
#   arm A  plugin on, default options        (verbatim rules)
#   arm B  plugin off                        (Claude Code's built-in summary)
#   arm C  plugin off, no /compact           (control, upper bound)
#   arm D  plugin on, options set to destroy (sensitivity check: must lose probes)
#
# Usage: bench/live.sh [runs]
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
case_dir="$here/case-parser"
out="$here/out-live"
runs="${1:-1}"
mkdir -p "$out"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1

DESTROY='{"pluginConfigs":{"verbatim-compaction@inline":{"options":{"preserveRecentMessages":0,"resultBudgetChars":0,"keepUnderChars":0,"headChars":0,"tailChars":0,"minReductionRatio":0}}}}'
NO_TOOLS='Read Grep Glob Edit Write MultiEdit Bash WebFetch WebSearch Task TodoWrite NotebookEdit'

read -r -d '' PY <<'PYEOF'
import json, subprocess, sys, os

case_dir, arm, root, destroy, out_path = sys.argv[1:6]
spec = json.load(open(os.path.join(case_dir, 'probes.json')))

cmd = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
       '--verbose', '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Bash']
if arm in ('A', 'D'):
    cmd += ['--plugin-dir', root]
if arm == 'D':
    cmd += ['--settings', destroy]

turns = [spec['task']]
if arm != 'C':
    turns.append('/compact')
turns.append(spec['probe_prompt'])

def message(text):
    return json.dumps({'type': 'user',
                       'message': {'role': 'user', 'content': [{'type': 'text', 'text': text}]}}) + '\n'

proc = subprocess.Popen(cmd, cwd=os.path.join(case_dir, 'repo'), stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
results = []
try:
    for turn in turns:
        proc.stdin.write(message(turn))
        proc.stdin.flush()
        while True:                      # read until this turn's result arrives
            line = proc.stdout.readline()
            if not line:
                raise SystemExit('session ended early')
            try:
                event = json.loads(line)
            except Exception:
                continue
            if event.get('type') == 'result':
                results.append(event.get('result', ''))
                break
finally:
    try:
        proc.stdin.close()
        proc.wait(timeout=30)
    except Exception:
        proc.kill()

open(out_path, 'w').write(results[-1] if results else '')
print(f'    arm {arm}: {len(results)} turns, answer {len(results[-1] if results else "")} bytes')
PYEOF

for run in $(seq 1 "$runs"); do
  for arm in A B C D; do
    echo "=== run $run arm $arm"
    "$case_dir/setup.sh" >/dev/null
    timeout 1200 python3 -c "$PY" "$case_dir" "$arm" "$root" "$DESTROY" "$out/run${run}-arm${arm}.txt"
  done
done

python3 "$here/score.py" "$case_dir/probes.json" "$out"
