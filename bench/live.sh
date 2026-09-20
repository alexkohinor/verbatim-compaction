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
# Two validity guards, because a clean-looking number has twice already turned
# out to measure nothing:
#   * the edit gate — a session whose edit never landed cannot be asked what it
#     edited, so its mutation probes are dropped rather than scored as forgotten;
#   * the narration capture — anything the assistant retold in its own words is
#     answerable with zero tool output, so the scorer drops those probes too.
#
# Usage: bench/live.sh [runs]
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
case_dir="$here/case-parser"
# The sandbox lives OUTSIDE the plugin directory on purpose: Claude Code refuses
# edits inside a --plugin-dir as sensitive, which silently broke the edit in
# exactly the two arms that load the plugin.
sandbox="${BENCH_SANDBOX:-$HOME/.cache/verbatim-compaction-bench/repo}"
out="$here/out-live"
runs="${1:-1}"
mkdir -p "$out"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1

DESTROY='{"pluginConfigs":{"verbatim-compaction@inline":{"options":{"preserveRecentMessages":0,"resultBudgetChars":0,"keepUnderChars":0,"headChars":0,"tailChars":0,"minReductionRatio":0}}}}'

read -r -d '' PY <<'PYEOF'
import hashlib, json, os, subprocess, sys

case_dir, arm, root, destroy, prefix, repo = sys.argv[1:7]
spec = json.load(open(os.path.join(case_dir, 'probes.json')))
target = os.path.join(repo, 'src', 'parser.ts')


def digest(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


before = digest(target)

cmd = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
       '--verbose', '--permission-mode', 'acceptEdits',
       '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Bash']
if arm in ('A', 'D'):
    cmd += ['--plugin-dir', root]
if arm == 'D':
    cmd += ['--settings', destroy]


def message(text):
    return json.dumps({'type': 'user',
                       'message': {'role': 'user', 'content': [{'type': 'text', 'text': text}]}}) + '\n'


proc = subprocess.Popen(cmd, cwd=repo, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL, text=True, bufsize=1)

narration = []      # what the assistant said in its own words, before compaction
results = []
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
                    if isinstance(block, dict) and block.get('type') in ('text', 'thinking'):
                        narration.append(block.get('text') or block.get('thinking') or '')
            if event.get('type') == 'result':
                results.append(event.get('result', ''))
                break
        if index == 0:
            edited = digest(target) != before
finally:
    try:
        proc.stdin.close()
        proc.wait(timeout=30)
    except Exception:
        proc.kill()

open(f'{prefix}.txt', 'w').write(results[-1] if results else '')
open(f'{prefix}-narration.txt', 'w').write('\n'.join(narration))
json.dump({'arm': arm, 'edited': bool(edited), 'turns': len(results)},
          open(f'{prefix}.meta.json', 'w'))
print(f'    arm {arm}: {len(results)} turns, edit landed: {edited}, '
      f'answer {len(results[-1] if results else "")} bytes, narration {len("".join(narration))} chars')
PYEOF

for run in $(seq 1 "$runs"); do
  for arm in A B C D; do
    echo "=== run $run arm $arm"
    "$case_dir/setup.sh" "$sandbox" >/dev/null
    timeout 1200 python3 -c "$PY" "$case_dir" "$arm" "$root" "$DESTROY" "$out/run${run}-arm${arm}" "$sandbox"
  done
done

python3 "$here/score.py" "$case_dir/probes.json" "$out"
