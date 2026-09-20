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
