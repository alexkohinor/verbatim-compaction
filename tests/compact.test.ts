import { beforeEach, describe, expect, it } from 'vitest';
import { compact, reductionRatio } from '../src/compact.js';
import { collectToolCalls } from '../src/collect.js';
import { transcriptChars } from '../src/apply.js';
import { estimateTokens } from '../src/estimate.js';
import type { Message } from '../src/types.js';
import { assistant, big, call, inlineCall, padding, resetIds, user } from './helpers.js';

beforeEach(resetIds);

const NO_PIN = { preserveRecentMessages: 0 };

function decision(result: ReturnType<typeof compact>, id: string) {
  return result.decisions.find((d) => d.id === id)!;
}

describe('pinning', () => {
  it('never touches the first message or the newest ones', () => {
    const messages: Message[] = [
      user('the task'),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
    ];
    const result = compact(messages, { preserveRecentMessages: 6 });
    expect(result.decisions.every((d) => d.reason === 'pinned')).toBe(true);
    expect(result.messages).toEqual(messages);
  });
});

describe('superseded reads', () => {
  it('removes an earlier read of a file that was read again', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
      ...padding(8),
    ];
    const result = compact(messages, {});
    expect(decision(result, 't1').action).toBe('drop_call');
    expect(decision(result, 't1').reason).toBe('superseded');
    expect(decision(result, 't2').action).toBe('keep');
    expect(result.messages.some((m) => m.toolUses.some((t) => t.tool_use_id === 'toolu_1'))).toBe(false);
    expect(result.messages.some((m) => (m.toolResults ?? []).length > 0)).toBe(true);
  });

  it('removes an earlier read of a file that was edited afterwards', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
      ...call('Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' }, 'ok'),
      ...padding(8),
    ];
    const result = compact(messages, {});
    expect(decision(result, 't1').action).toBe('drop_call');
    expect(decision(result, 't2').action).toBe('keep');
  });

  it('keeps a read of a different slice of the same file', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Read', { file_path: '/a.ts', offset: 1, limit: 50 }, big(5000)),
      ...call('Read', { file_path: '/a.ts', offset: 900, limit: 50 }, big(5000)),
      ...padding(8),
    ];
    const result = compact(messages, {});
    expect(decision(result, 't1').action).toBe('keep');
  });

  it('drops a repeated identical Grep but not a different one', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Grep', { pattern: 'foo' }, big(3000)),
      ...call('Grep', { pattern: 'bar' }, big(3000)),
      ...call('Grep', { pattern: 'foo' }, big(3000)),
      ...padding(8),
    ];
    const result = compact(messages, {});
    expect(decision(result, 't1').reason).toBe('duplicate');
    expect(decision(result, 't1').action).toBe('drop_call');
    expect(decision(result, 't2').action).toBe('keep');
    expect(decision(result, 't3').action).toBe('keep');
  });

  it('can be told to keep the record and cut only the output', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
      ...padding(8),
    ];
    const result = compact(messages, { dropSupersededCalls: false });
    expect(decision(result, 't1').action).toBe('truncate_result');
  });
});

describe('calls that changed something', () => {
  it('never removes the record of a write, however stale', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' }, big(5000)),
      ...call('Edit', { file_path: '/a.ts', old_string: 'b', new_string: 'c' }, big(5000)),
      ...call('Write', { file_path: '/a.ts', content: 'x' }, big(5000)),
      ...padding(8),
    ];
    const result = compact(messages, {});
    for (const id of ['t1', 't2', 't3']) {
      expect(decision(result, id).action).not.toBe('drop_call');
    }
    const kept = result.messages.flatMap((m) => m.toolUses.map((t) => t.tool));
    expect(kept.filter((tool) => tool === 'Edit')).toHaveLength(2);
    expect(kept.filter((tool) => tool === 'Write')).toHaveLength(1);
  });

  it('never removes an unknown tool call either', () => {
    const messages: Message[] = [
      user('task'),
      ...call('mcp__db__query', { sql: 'select 1' }, big(5000)),
      ...call('mcp__db__query', { sql: 'select 1' }, big(5000)),
      ...padding(8),
    ];
    const result = compact(messages, {});
    expect(decision(result, 't1').action).toBe('truncate_result');
    expect(decision(result, 't1').reason).toBe('duplicate');
  });

  it('classifies a Bash call by its command', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Bash', { command: 'git status' }, big(3000)),
      ...call('Bash', { command: 'git status' }, big(3000)),
      ...call('Bash', { command: 'npm run build' }, big(3000)),
      ...call('Bash', { command: 'npm run build' }, big(3000)),
      ...padding(8),
    ];
    const result = compact(messages, {});
    expect(decision(result, 't1').action).toBe('drop_call');
    expect(decision(result, 't3').action).toBe('truncate_result');
  });
});

describe('the verbatim budget', () => {
  it('keeps the newest output verbatim and cuts what is older', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Read', { file_path: '/a.ts' }, big(8000, 'a')),
      ...call('Read', { file_path: '/b.ts' }, big(8000, 'b')),
      ...call('Read', { file_path: '/c.ts' }, big(8000, 'c')),
      ...padding(8),
    ];
    const result = compact(messages, { resultBudgetChars: 10_000 });
    expect(decision(result, 't3').action).toBe('keep');
    expect(decision(result, 't2').reason).toBe('over_budget');
    expect(decision(result, 't1').reason).toBe('over_budget');
    const texts = result.messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.text));
    expect(texts.some((text) => text.includes('verbatim-compaction cut'))).toBe(true);
    expect(texts.some((text) => text.length === 8000)).toBe(true);
  });

  it('keeps head and tail of what it cuts, byte for byte', () => {
    const output = `${big(500, 'h')}${big(9000, 'm')}${big(300, 't')}`;
    const messages: Message[] = [
      user('task'),
      ...call('Read', { file_path: '/a.ts' }, output),
      ...padding(8),
    ];
    const result = compact(messages, { resultBudgetChars: 0, headChars: 400, tailChars: 200 });
    const text = result.messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.text))[0]!;
    expect(text.startsWith(output.slice(0, 400))).toBe(true);
    expect(text.endsWith(output.slice(-200))).toBe(true);
    expect(text).toContain('re-run the tool');
  });

  it('leaves small results alone', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Read', { file_path: '/a.ts' }, 'tiny'),
      ...padding(8),
    ];
    const result = compact(messages, { resultBudgetChars: 0 });
    expect(decision(result, 't1').reason).toBe('small_result');
    expect(result.messages).toEqual(messages);
  });
});

describe('rebuilding the transcript', () => {
  it('returns untouched messages as the very same objects', () => {
    const messages: Message[] = [
      user('task'),
      assistant('thinking'),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
      ...padding(8),
    ];
    const result = compact(messages, {});
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[1]);
    expect(result.messages.at(-1)).toBe(messages.at(-1));
  });

  it('removes a message a dropped call left empty and never orphans a result', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
      ...padding(8),
    ];
    const result = compact(messages, {});
    expect(result.stats.messagesAfter).toBe(messages.length - 2);
    const useIds = new Set(result.messages.flatMap((m) => m.toolUses.map((t) => t.tool_use_id)));
    for (const message of result.messages) {
      for (const r of message.toolResults ?? []) expect(useIds.has(r.tool_use_id)).toBe(true);
    }
  });

  it('cuts an outcome stored on the tool_use itself', () => {
    const messages: Message[] = [
      user('task'),
      ...inlineCall('Read', { file_path: '/a.ts' }, big(9000)),
      ...padding(8),
    ];
    const calls = collectToolCalls(messages, {
      preserveRecentMessages: 6,
      readTools: [],
      writeTools: [],
    });
    expect(calls).toHaveLength(1);
    const result = compact(messages, { resultBudgetChars: 0 });
    expect(decision(result, 't1').action).toBe('truncate_result');
    expect(result.stats.charsBefore).toBeGreaterThan(9000);
    expect(reductionRatio(result)).toBeGreaterThan(0.5);
  });
});

describe('accounting', () => {
  it('counts an outcome once, whether it sits on the use or the result', () => {
    const [useMessage, resultMessage] = call('Read', { file_path: '/a.ts' }, big(1000)) as [Message, Message];
    expect(transcriptChars([useMessage, resultMessage])).toBeLessThan(1200);
  });

  it('charges scripts by their own rate', () => {
    expect(estimateTokens('hello world, this is plain ascii text')).toBeLessThan(
      estimateTokens('привет мир, это обычный русский текст здесь'),
    );
    expect(estimateTokens('')).toBe(0);
  });

  it('reports no reduction and no change when there is nothing to cut', () => {
    const messages: Message[] = [user('task'), assistant('done')];
    const result = compact(messages, {});
    expect(result.messages).toEqual(messages);
    expect(reductionRatio(result)).toBe(0);
    expect(result.stats.calls).toBe(0);
  });

  it('ignores a call still in flight', () => {
    const messages: Message[] = [
      user('task'),
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool: 'Read', input: {} }] },
      ...padding(8),
    ];
    expect(compact(messages, {}).stats.calls).toBe(0);
  });
});
