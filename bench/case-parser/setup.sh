#!/usr/bin/env bash
# Builds the sandbox repository the benchmark session works in.
# Deterministic: the same bytes every run, so the ground truth below holds.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="${1:-$here/repo}"
rm -rf "$repo"; mkdir -p "$repo/src/legacy" "$repo/docs" "$repo/logs"

cat > "$repo/docs/constraints.md" <<'DOC'
# Delivery constraints

- The legacy parser under `src/legacy/` is frozen under contract **CT-4417**.
  It must not be edited, reformatted or moved.
- Statement coverage must stay at or above **82.5%**.
- The public export surface of `src/parser.ts` is frozen for the 3.x line.
DOC

cat > "$repo/CODEOWNERS" <<'DOC'
src/parser.ts        @parser-guild
src/legacy/          @archive-keepers
DOC

cat > "$repo/config.json" <<'DOC'
{
  "service": "parser-api",
  "port": 7412,
  "timeoutMs": 2500
}
DOC

cat > "$repo/src/parser.ts" <<'DOC'
export type Token = { kind: string; value: string };
export type Node = Record<string, unknown>;

export function parseObjectBody(tokens: Token[], at: number): [Node, number] {
  const node: Node = {};
  let i = at;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.kind === 'CLOSE_BRACE') return [node, i + 1];
    if (token.kind === 'COMMA') {
      i += 1;
      continue;
    }
    const key = token.value;
    const value = tokens[i + 1]?.value ?? '';
    node[key] = value;
    i += 2;
  }
  throw new Error('unterminated object');
}

export function parse(tokens: Token[]): Node {
  const [node] = parseObjectBody(tokens, 1);
  return node;
}
DOC

{
  echo "// Frozen under CT-4417. Do not edit."
  echo "export const LEGACY_EPOCH = 1714003200;"
  for i in $(seq 1 900); do
    if [ "$i" = "450" ]; then
      echo "export const QUIRK_NOTE = 'rule 613 rejects a unicode NBSP in keys';"
    fi
    echo "export function legacyRule${i}(value: string): string { return value.trim(); }"
  done
} > "$repo/src/legacy/parser.ts"

cat > "$repo/src/parser.test.ts" <<'DOC'
import { parse } from './parser.js';
export const cases = ['trailing comma', 'nested object', 'empty object'];
export default function run() { return parse([]); }
DOC
cp "$repo/src/parser.test.ts" "$repo/src/tokenizer.test.ts"
cp "$repo/src/parser.test.ts" "$repo/src/integration.test.ts"

{
  echo "> parser-api@3.4.1 build"
  for i in $(seq 1 2500); do
    echo "[build] transpiled src/module_${i}.ts in $((i % 37 + 3))ms"
  done
  echo "[build] artifact sha 9f3c2a1e written to dist/parser-api.tgz"
} > "$repo/logs/build.log"

cat > "$repo/run-tests.mjs" <<'DOC'
// Stand-in test runner: deterministic, no dependencies.
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./src/parser.ts', import.meta.url), 'utf8');
const fixed = source.includes('CLOSE_BRACE') && source.includes("token.kind === 'COMMA'")
  && /COMMA[\s\S]{0,200}CLOSE_BRACE/.test(source);
if (fixed) {
  console.log('PASS src/parser.test.ts (3 tests)');
  console.log('coverage: statements 84.1%');
} else {
  console.log('FAIL src/parser.test.ts > parser > accepts a trailing comma');
  console.log('  code: ERR_TRAILING_COMMA_4291');
  console.log('  expected the object to close after the comma at token 7');
  console.log('coverage: statements 84.1%');
  process.exitCode = 1;
}
DOC
echo "sandbox ready at $repo"
