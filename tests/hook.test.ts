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
