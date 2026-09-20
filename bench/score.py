#!/usr/bin/env python3
"""Scores the benchmark answers — and refuses to score what it may not.

A probe counts for an arm only when that session could honestly be asked it:

  * dropped as RETOLD  — the answer is in what the assistant said in its own
    words before compaction, so no scheme had to keep any tool output for it;
  * dropped as NO EDIT — a mutation probe in a session whose edit never landed,
    which measures a failed task rather than a lost memory.

Usage: score.py <probes.json> <out-dir>
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ARM_NAMES = {
    'A': 'verbatim rules',
    'B': 'built-in summary',
    'C': 'no compaction',
    'D': 'rules set to destroy',
}
MUTATION_KINDS = {'own_mutation', 'pre_edit_state'}


def lines_of(text):
    """Maps '3. 7412' -> {3: '7412'}, tolerating bullets and stray formatting."""
    answers = {}
    for line in text.splitlines():
        match = re.match(r'\s*\**(\d{1,2})[.)]\s*(.*)', line.strip())
        if match:
            answers[int(match.group(1))] = match.group(2).strip()
    return answers


def read(path):
    return path.read_text(encoding='utf-8', errors='replace') if path.exists() else ''


def main():
    spec = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    probes = spec['probes']

    per_arm = defaultdict(lambda: [0, 0])           # arm -> [hits, scored]
    per_probe = defaultdict(lambda: defaultdict(list))
    dropped = defaultdict(int)                      # reason -> probe-instances
    no_edit = []

    for path in sorted(out.glob('run*-arm?.txt')):
        run, arm = re.match(r'run(\d+)-arm(\w)\.txt', path.name).groups()
        stem = str(path)[:-4]
        answers = lines_of(read(path))
        narration = read(Path(stem + '-narration.txt')).lower()
        if not narration:                           # older harness: one file per run
            narration = read(out / f'run{run}-narration.txt').lower()
        meta_path = Path(stem + '.meta.json')
        meta = json.loads(read(meta_path)) if meta_path.exists() else {}
        edited = meta.get('edited', True)
        if not edited:
            no_edit.append(f'run {run} arm {arm}')

        for probe in probes:
            expect = [e.lower() for e in probe['expect']]
            if narration and any(e in narration for e in expect):
                per_probe[probe['n']][arm].append(None)
                dropped['retold by the assistant'] += 1
                continue
            if probe['kind'] in MUTATION_KINDS and not edited:
                per_probe[probe['n']][arm].append(None)
                dropped['edit never landed'] += 1
                continue
            got = answers.get(probe['n'], '').lower()
            ok = any(e in got for e in expect)
            per_probe[probe['n']][arm].append(ok)
            per_arm[arm][0] += ok
            per_arm[arm][1] += 1

    arms = sorted(per_arm)
    print(f'\n{"arm":<24}{"probes recalled":>18}')
    for arm in arms:
        hits, scored = per_arm[arm]
        pct = f'{100 * hits / scored:>5.0f}%' if scored else '    -'
        print(f'{arm} {ARM_NAMES.get(arm, ""):<22}{hits:>6}/{scored:<5}{pct}')

    print(f'\n{"probe":<6}{"kind":<18}' + ''.join(f'{a:>7}' for a in arms))
    for probe in probes:
        row = ''
        for arm in arms:
            results = [r for r in per_probe[probe['n']][arm] if r is not None]
            if not results:
                row += f'{"n/a":>7}'
            else:
                share = sum(results) / len(results)
                mark = '+' if share == 1 else '-' if share == 0 else f'{share:.0%}'
                row += f'{mark:>7}'
        print(f'{probe["n"]:<6}{probe["kind"]:<18}{row}')
    print('\n+ recalled in every run, - in none, a percentage in between')

    for reason, count in sorted(dropped.items()):
        print(f'dropped, {reason}: {count} probe-instances')
    if no_edit:
        print(f'sessions whose edit never landed: {", ".join(no_edit)}')


if __name__ == '__main__':
    main()
