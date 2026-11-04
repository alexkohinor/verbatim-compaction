import { beforeEach, describe, expect, it } from 'vitest';
import { compact } from '../src/compact.js';
import { cutInput } from '../src/inputs.js';
import { NOTE_PREFIX } from '../src/plan.js';
import type { Message, ToolUse } from '../src/types.js';
import { resolveHookConfig } from '../hooks/verbatim-compaction.js';
import { big, call, padding, resetIds, user } from './helpers.js';

beforeEach(resetIds);

function useOf(result: ReturnType<typeof compact>, toolUseId: string): ToolUse | undefined {
  for (const message of result.messages) {
    const found = message.toolUses.find((tool) => tool.tool_use_id === toolUseId);
    if (found) return found;
  }
  return undefined;
}

function decision(result: ReturnType<typeof compact>, id: string) {
  return result.decisions.find((d) => d.id === id)!;
}

describe('input budget', () => {
  it('cuts the content of an old Write but keeps the call, its path and its result', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Write', { file_path: '/old.ts', content: big(30_000, 'a') }, 'File created'),
      ...call('Write', { file_path: '/new.ts', content: big(10_000, 'b') }, 'File created'),
      ...padding(8),
    ];
    const result = compact(messages, { inputBudgetChars: 15_000 });

    expect(decision(result, 't1').inputAction).toBe('truncate_input');
    expect(decision(result, 't1').action).toBe('keep');
    expect(decision(result, 't2').inputAction).toBe('keep');

    const old = useOf(result, 'toolu_1')!;
    expect(old.tool).toBe('Write');
    expect(old.input['file_path']).toBe('/old.ts');
    const content = old.input['content'] as string;
    expect(content.length).toBeLessThan(1_000);
    expect(content).toContain(`${NOTE_PREFIX} `);
    expect(content.startsWith('a'.repeat(400))).toBe(true);
    expect(content.endsWith('a'.repeat(200))).toBe(true);

    expect(useOf(result, 'toolu_2')!.input['content']).toBe(big(10_000, 'b'));
    expect(result.messages.some((m) => (m.toolResults ?? []).some((r) => r.tool_use_id === 'toolu_1'))).toBe(
      true,
    );
    expect(result.stats.inputsTruncated).toBe(1);
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore - 25_000);
  });

  it('never touches the input of a pinned call', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Write', { file_path: '/a.ts', content: big(30_000) }, 'ok'),
    ];
    const result = compact(messages, { inputBudgetChars: 0, preserveRecentMessages: 6 });
    expect(decision(result, 't1').inputAction).toBe('keep');
    expect(result.messages).toEqual(messages);
  });

  it('cuts an old heredoc in a Bash command and keeps its head', () => {
    const script = `python3 - <<'EOF'\n${big(8_000, 'print(1)\n')}EOF`;
    const messages: Message[] = [
      user('task'),
      ...call('Bash', { command: script, description: 'run the script' }, 'done'),
      ...padding(8),
    ];
    const result = compact(messages, { inputBudgetChars: 1_000 });
    const bash = useOf(result, 'toolu_1')!;
    expect(bash.input['description']).toBe('run the script');
    expect((bash.input['command'] as string).startsWith("python3 - <<'EOF'")).toBe(true);
    expect((bash.input['command'] as string).length).toBeLessThan(1_000);
  });

  it('cuts nested strings, such as MultiEdit edits, and keeps short ones', () => {
    const input = {
      file_path: '/a.ts',
      edits: [
        { old_string: big(5_000, 'o'), new_string: 'short' },
        { old_string: 'x', new_string: big(5_000, 'n') },
      ],
    };
    const cut = cutInput(input, 600, 400, 200);
    const edits = cut['edits'] as Array<Record<string, string>>;
    expect(cut['file_path']).toBe('/a.ts');
    expect(edits[0]!['new_string']).toBe('short');
    expect(edits[1]!['old_string']).toBe('x');
    expect(edits[0]!['old_string']!.length).toBeLessThan(1_000);
    expect(edits[1]!['new_string']!.length).toBeLessThan(1_000);
  });

  it('returns the same input object when nothing is long enough to cut', () => {
    const input = { file_path: '/a.ts', old_string: 'a', new_string: 'b' };
    expect(cutInput(input, 600, 400, 200)).toBe(input);
  });

  it('keeps every input whole with an infinite budget', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Write', { file_path: '/a.ts', content: big(30_000) }, 'ok'),
      ...padding(8),
    ];
    const result = compact(messages, { inputBudgetChars: Infinity });
    expect(result.decisions.every((d) => d.inputAction === 'keep')).toBe(true);
    expect(useOf(result, 'toolu_1')!.input['content']).toBe(big(30_000));
  });

  it('cuts the result and the input of the same call together', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Bash', { command: `cat <<'EOF' > /a\n${big(5_000)}\nEOF` }, big(5_000, 'r')),
      ...padding(8),
    ];
    const result = compact(messages, { inputBudgetChars: 0, resultBudgetChars: 0 });
    const d = decision(result, 't1');
    expect(d.action).toBe('truncate_result');
    expect(d.inputAction).toBe('truncate_input');
    const use = useOf(result, 'toolu_1')!;
    expect((use.input['command'] as string).length).toBeLessThan(1_000);
    expect((use.text ?? '').length).toBeLessThan(1_000);
  });

  it('leaves untouched messages as the objects they came in as', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Write', { file_path: '/a.ts', content: big(30_000) }, 'ok'),
      ...call('Read', { file_path: '/b.ts' }, 'small'),
      ...padding(8),
    ];
    const result = compact(messages, { inputBudgetChars: 0 });
    expect(result.messages).toContain(messages[3]);
    expect(result.messages).not.toContain(messages[1]);
  });
});

describe('hook config for the input budget', () => {
  it('reads 0 from userConfig as «keep every input whole»', () => {
    expect(resolveHookConfig({ inputBudgetChars: 0 }).inputBudgetChars).toBe(Infinity);
    expect(resolveHookConfig({ inputBudgetChars: 5_000 }).inputBudgetChars).toBe(5_000);
    expect(resolveHookConfig({}).inputBudgetChars).toBeUndefined();
  });
});
