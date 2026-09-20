/**
 * Measures what the rules actually free on real transcripts.
 *
 * Usage: tsx scripts/measure.ts <messages.json> [...]
 * where each file is the output of scripts/transcript_to_messages.py.
 * Everything stays on this machine.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { compact, reductionRatio, type Message } from '../src/index.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: tsx scripts/measure.ts <messages.json> [...]');
  process.exit(1);
}

const rows: string[] = [];
let totalBefore = 0;
let totalAfter = 0;

for (const file of files) {
  const messages = JSON.parse(readFileSync(file, 'utf8')) as Message[];
  const result = compact(messages, {});
  const { stats } = result;
  totalBefore += stats.charsBefore;
  totalAfter += stats.charsAfter;
  const reasons = new Map<string, number>();
  for (const decision of result.decisions) {
    if (decision.action === 'keep') continue;
    reasons.set(decision.reason, (reasons.get(decision.reason) ?? 0) + decision.savedChars);
  }
  const breakdown = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, chars]) => `${reason} ${(chars / 1000).toFixed(0)}k`)
    .join(', ');
  rows.push(
    [
      basename(file).slice(0, 12).padEnd(13),
      String(stats.messagesBefore).padStart(6),
      `${(stats.charsBefore / 1e6).toFixed(2)}M`.padStart(8),
      `${(stats.charsAfter / 1e6).toFixed(2)}M`.padStart(8),
      `${(reductionRatio(result) * 100).toFixed(1)}%`.padStart(7),
      String(stats.calls).padStart(6),
      String(stats.callsDropped).padStart(8),
      String(stats.resultsTruncated).padStart(6),
      `${stats.ms}ms`.padStart(7),
      `  ${breakdown}`,
    ].join(' '),
  );
}

console.log(
  ['session      ', '  msgs', '  before', '   after', '   less', ' calls', ' dropped', '   cut', '   time', '  saved by'].join(' '),
);
for (const row of rows) console.log(row);
console.log(
  `\ntotal ${(totalBefore / 1e6).toFixed(2)}M → ${(totalAfter / 1e6).toFixed(2)}M chars (${(
    ((totalBefore - totalAfter) / totalBefore) *
    100
  ).toFixed(1)}% less)`,
);
