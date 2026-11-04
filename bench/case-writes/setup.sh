#!/usr/bin/env bash
# Sandbox for the write-heavy case: the session writes a 30 KB file whose rows
# exist nowhere else in its context once the generator's output is over budget.
# Deterministic: the same bytes every run, so the ground truth in probes.json holds.
set -euo pipefail
repo="${1:?sandbox path}"
rm -rf "$repo"; mkdir -p "$repo/docs" "$repo/logs" "$repo/src"

cat > "$repo/docs/brief.md" <<'DOC'
# Brief
Ticket **WR-5530**. The table goes to `src/table.ts`; reviewers: **@tables-crew**.
DOC
cat > "$repo/config.json" <<'DOC'
{ "service": "tables", "region": "eu-north-7", "retries": 4 }
DOC
cat > "$repo/docs/notes.md" <<'DOC'
Release train: **Kestrel**. Freeze starts on day 19.
DOC

cat > "$repo/gen.mjs" <<'DOC'
import { createHash } from 'node:crypto';
for (let i = 1; i <= 800; i += 1) {
  const id = String(i).padStart(4, '0');
  const value = createHash('sha256').update(`row-${i}`).digest('hex').slice(0, 16);
  console.log(`ROW_${id} ${value}`);
}
DOC

cat > "$repo/check.mjs" <<'DOC'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
let text = '';
try { text = readFileSync('src/table.ts', 'utf8'); } catch { console.log('CHECK FAIL missing'); process.exit(1); }
let ok = 0;
for (let i = 1; i <= 800; i += 1) {
  const id = String(i).padStart(4, '0');
  const value = createHash('sha256').update(`row-${i}`).digest('hex').slice(0, 16);
  if (text.includes(`export const ROW_${id} = '${value}';`)) ok += 1;
}
console.log(ok === 800 ? 'CHECK PASS code K-7731' : `CHECK FAIL ${ok}/800`);
DOC

python3 - "$repo/logs/build.log" <<'PY'
import hashlib, sys
lines = [f"[{i:05d}] step {i}: compiled unit_{i:04d} in {(i * 37) % 900 + 12} ms" for i in range(1, 900)]
lines.append("[final] artifact sha 9c41e07ab2d3 written to dist/")
open(sys.argv[1], "w").write("\n".join(lines) + "\n")
PY
