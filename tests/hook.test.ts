import { beforeEach, describe, expect, it } from 'vitest';
import { compact } from '../src/compact.js';
import {
  decisionLogLines,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/verbatim-compaction.js';
import type { SessionMessage } from 'claude-code';
import type { Message } from '../src/types.js';

/** The tests build library messages; the hook takes the engine's shape. */
const asSession = (messages: readonly Message[]): SessionMessage[] =>
  messages as unknown as SessionMessage[];
import { pinnedTailStart } from '../src/collect.js';
import { big, call, padding, resetIds, user } from './helpers.js';

beforeEach(resetIds);

describe('hook config', () => {
  it('reads userConfig and falls back to defaults', () => {
    const config = resolveHookConfig({ resultBudgetChars: 1000, minReductionRatio: 0.5 });
    expect(config.resultBudgetChars).toBe(1000);
    expect(config.minReductionRatio).toBe(0.5);
    expect(resolveHookConfig({ headChars: 'nope' as unknown as number }).headChars).toBeUndefined();
  });

  it('leaves auto-compaction off unless it is asked for', () => {
    expect(resolveHookConfig({}).compactAtPercent).toBe(0);
    expect(resolveHookConfig({ compactAtPercent: 70 }).compactAtPercent).toBe(70);
  });
});

describe('session messages', () => {
  it('hands back the engine objects for untouched messages', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
      ...call('Read', { file_path: '/a.ts' }, big(5000)),
      ...padding(8),
    ];
    const input = messages.map((message, i) => ({ ...message, handle: `h${i}` }));
    const result = compact(input as Message[], {});
    const mapped = toSessionMessages(asSession(input), result.messages);
    expect(mapped[0]!.handle).toBe('h0');
    expect(mapped.every((message) => message.handle !== undefined)).toBe(true);
    expect(mapped).toHaveLength(input.length - 2);
  });

  it('hands back a handle-less copy for a message it rewrote', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Read', { file_path: '/a.ts' }, big(9000)),
      ...padding(8),
    ];
    const input = messages.map((message, i) => ({ ...message, handle: `h${i}` }));
    const result = compact(input as Message[], { resultBudgetChars: 0 });
    const mapped = toSessionMessages(asSession(input), result.messages);
    const rewritten = mapped.filter((message) => message.handle === undefined);
    expect(rewritten).toHaveLength(2);
    expect(rewritten.some((message) => (message.toolResults ?? [])[0]?.text.includes('cut'))).toBe(
      true,
    );
  });

  it('rebuilds every tool entry outside the protected ends once one is rebuilt (one response, many entries)', () => {
    // Write + three parallel Reads of ONE response arrive as separate entries,
    // with the Write's result between them; only the Write's input is cut.
    const messages: Message[] = [
      user('task'),
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'w', tool: 'Write', input: { file_path: '/t.ts', content: big(30_000) }, text: 'ok' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'w', text: 'ok' }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a' }, text: 'A' }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r2', tool: 'Read', input: { file_path: '/b' }, text: 'B' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'A' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r2', text: 'B' }] },
      ...padding(6),
    ];
    const input = messages.map((message, i) => ({ ...message, handle: `h${i}` }));
    const result = compact(input as Message[], { inputBudgetChars: 0 });
    const mapped = toSessionMessages(asSession(input), result.messages, 6);
    const toolEntries = mapped.slice(1, mapped.length - 6);
    // Write · its result · both Reads as ONE call message · both results as ONE.
    expect(toolEntries.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
    expect(toolEntries.every((message) => message.handle === undefined)).toBe(true);
    expect(toolEntries[2]!.toolUses.map((t) => t.tool_use_id)).toEqual(['r1', 'r2']);
    expect(toolEntries[3]!.toolResults!.map((r) => r.tool_use_id)).toEqual(['r1', 'r2']);
    expect(toolEntries[2]!.toolUses[0]!.input).toEqual({ file_path: '/a' });
    expect(mapped[0]!.handle).toBe('h0');
    expect(mapped.slice(-6).every((message) => message.handle !== undefined)).toBe(true);
  });

  it('moves the pinned tail back so it never starts inside a run of call entries', () => {
    const read = (id: string): Message => ({
      role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Read', input: { file_path: `/${id}` }, text: id }],
    });
    const result = (id: string): Message => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: id }] });
    const messages: Message[] = [
      user('task'),
      ...call('Write', { file_path: '/t.ts', content: big(30_000) }, 'ok'),
      read('r1'), read('r2'), result('r1'), result('r2'), ...padding(3),
    ];
    // preserve 6 would start the tail at r2 — inside the r1/r2 response.
    expect(pinnedTailStart(messages, 6)).toBe(3);
    const input = messages.map((message, i) => ({ ...message, handle: `h${i}` }));
    const compacted = compact(input as Message[], { inputBudgetChars: 0, preserveRecentMessages: 6 });
    const mapped = toSessionMessages(asSession(input), compacted.messages, 6);
    const r1 = mapped.find((m) => m.toolUses.some((t) => t.tool_use_id === 'r1'))!;
    const r2 = mapped.find((m) => m.toolUses.some((t) => t.tool_use_id === 'r2'))!;
    expect(r1.handle).toBe('h3');
    expect(r2.handle).toBe('h4');
  });

  it('keeps every handle when nothing was rebuilt', () => {
    const messages: Message[] = [user('task'), ...call('Read', { file_path: '/a' }, 'small'), ...padding(6)];
    const input = messages.map((message, i) => ({ ...message, handle: `h${i}` }));
    const result = compact(input as Message[], {});
    const mapped = toSessionMessages(asSession(input), result.messages, 6);
    expect(mapped.every((message) => message.handle !== undefined)).toBe(true);
  });
});

describe('reporting', () => {
  it('summarises what happened', () => {
    const messages: Message[] = [
      user('task'),
      ...call('Read', { file_path: '/a.ts' }, big(9000)),
      ...call('Read', { file_path: '/a.ts' }, big(9000)),
      ...padding(8),
    ];
    const result = compact(messages, {});
    expect(summarize(result)).toMatch(/^\d+% smaller/);
    expect(summarize(result)).toContain('1 calls dropped');
  });

  it('splits the decision log into lines under the host limit', () => {
    const messages: Message[] = [user('task')];
    for (let i = 0; i < 200; i += 1) messages.push(...call('Grep', { pattern: 'x' }, big(2000)));
    messages.push(...padding(8));
    const lines = decisionLogLines(compact(messages, {}), 200);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(200);
  });

  it('says so when nothing was cut', () => {
    expect(decisionLogLines(compact([user('task')], {}))).toEqual(['decisions: (nothing cut)']);
  });
});

describe('registration', () => {
  it('registers both hooks without asking for any credential', async () => {
    const { register } = await import('../hooks/verbatim-compaction.js');
    const registered: string[] = [];
    register(((pattern: string) => {
      registered.push(pattern);
    }) as never, {});
    expect(registered).toEqual(['session.compact', 'turn.complete']);
  });
});
