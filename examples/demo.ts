import { compact, reductionRatio } from '../src/index.js';
import type { Message } from '../src/index.js';

let n = 0;
function call(
  tool: string,
  input: Record<string, unknown>,
  output: string,
  isError = false,
): Message[] {
  const tool_use_id = `toolu_${++n}`;
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id, tool, input, text: output, isError }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id, text: output, isError }] },
  ];
}
const user = (text: string): Message => ({ role: 'user', text, toolUses: [] });
const assistant = (text: string): Message => ({ role: 'assistant', text, toolUses: [] });

const parser = `export function parse(tokens: Token[]): Node {\n${'  // …\n'.repeat(400)}}\n`;
const legacy = `// legacy parser\n${'export const legacy = true;\n'.repeat(300)}`;
const build = `> build\n${'transpiled src/file.ts\n'.repeat(600)}done in 12s\n`;
const testCommand = 'npx vitest run src/parser.test.ts';

const messages: Message[] = [
  user('Fix the failing parser test. Do not touch legacy/. Keep the public API stable.'),
  assistant('Looking at the tree first.'),
  ...call(
    'Glob',
    { pattern: 'src/**/*.ts' },
    'src/parser.ts\nsrc/parser.test.ts\nsrc/legacy/parser.ts',
  ),
  ...call('Read', { file_path: 'src/legacy/parser.ts' }, legacy),
  assistant('Unrelated. Reading the real parser.'),
  ...call('Read', { file_path: 'src/parser.ts' }, parser),
  ...call(
    'Bash',
    { command: testCommand },
    'FAIL parser > trailing comma\n  at parser.test.ts:42',
    true,
  ),
  ...call('Bash', { command: 'npm run build' }, build),
  assistant('The token loop stops too early. Patching it.'),
  ...call(
    'Edit',
    {
      file_path: 'src/parser.ts',
      old_string: 'advance();',
      new_string: 'if (next === CLOSE) continue;\nadvance();',
    },
    'Edited src/parser.ts',
  ),
  ...call('Read', { file_path: 'src/parser.ts' }, parser.replace('// …', '// patched')),
  ...call('Bash', { command: 'git status --porcelain' }, ' M src/parser.ts'),
  assistant('Re-running the test.'),
  ...call('Bash', { command: testCommand }, 'PASS src/parser.test.ts (1 test)'),
  assistant('Green. The public API is unchanged.'),
];

const result = compact(messages);
console.log(
  `chars ${result.stats.charsBefore} → ${result.stats.charsAfter} (${Math.round(
    reductionRatio(result) * 100,
  )}% smaller)`,
);
console.log(`~tokens ${result.stats.tokensBefore} → ${result.stats.tokensAfter}`);
console.log(`messages ${result.stats.messagesBefore} → ${result.stats.messagesAfter}\n`);
for (const d of result.decisions) {
  console.log(
    `${d.id.padEnd(4)} ${d.tool.padEnd(6)} ${d.effect.padEnd(7)} ${d.action.padEnd(
      16,
    )} ${d.reason.padEnd(13)} -${d.savedChars}ch  ${d.target.slice(0, 48)}`,
  );
}
