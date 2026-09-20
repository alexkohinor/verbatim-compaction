#!/usr/bin/env python3
"""Scores the benchmark answers: one point per probe whose expected string is there.

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


def lines_of(text):
    """Maps '3. 7412' → {3: '7412'}, tolerating bullets and stray formatting."""
    answers = {}
    for line in text.splitlines():
        m = re.match(r'\s*\**(\d{1,2})[.)]\s*(.*)', line.strip())
        if m:
            answers[int(m.group(1))] = m.group(2).strip()
    return answers


def main():
    spec = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    probes = spec['probes']
    per_arm = defaultdict(list)
    per_probe = defaultdict(dict)

    leaked = defaultdict(set)   # run -> probes the assistant already retold
    for path in out.glob('run*-narration.txt'):
        run = re.match(r'run(\d+)-narration\.txt', path.name).group(1)
        text = path.read_text().lower()
        for probe in probes:
            if any(e.lower() in text for e in probe['expect']):
                leaked[run].add(probe['n'])

    for path in sorted(out.glob('run*-arm*.txt')):
        run, arm = re.match(r'run(\d+)-arm(\w)\.txt', path.name).groups()
        answers = lines_of(path.read_text())
        hits = scored = 0
        for probe in probes:
            if probe['n'] in leaked.get(run, ()):
                per_probe[probe['n']].setdefault(arm, []).append(None)
                continue
            got = answers.get(probe['n'], '')
            ok = any(e.lower() in got.lower() for e in probe['expect'])
            hits += ok
            scored += 1
            per_probe[probe['n']].setdefault(arm, []).append(ok)
        per_arm[arm].append((int(run), hits, scored))

    if leaked:
        for run in sorted(leaked):
            dropped = ', '.join(str(n) for n in sorted(leaked[run]))
            print(f'run {run}: probes retold by the assistant before compaction, not scored: {dropped or "none"}')

    print(f'\n{"arm":<22}{"probes recalled":>18}')
    for arm in sorted(per_arm):
        runs = per_arm[arm]
        total = sum(h for _, h, _ in runs)
        outof = sum(n for _, _, n in runs)
        pct = f'{100*total/outof:>5.0f}%' if outof else '    —'
        print(f'{arm} {ARM_NAMES.get(arm, ""):<20}{total:>8}/{outof:<4} {pct}')

    print(f'\n{"probe":<6}{"kind":<18}' + ''.join(f'{a:>6}' for a in sorted(per_arm)))
    for probe in probes:
        row = ''
        for arm in sorted(per_arm):
            results = [r for r in per_probe[probe['n']].get(arm, []) if r is not None]
            mark = 'leak' if not results else '+' if all(results) else '-' if not any(results) else '±'
            row += f'{mark:>6}'
        print(f'{probe["n"]:<6}{probe["kind"]:<18}{row}')
    print('\n+ recalled in every run, - in none, ± mixed')


if __name__ == '__main__':
    main()
