import { applyDecisions, transcriptChars } from './apply.js';
import { collectToolCalls } from './collect.js';
import { estimateTokens } from './estimate.js';
import { planDecisions } from './plan.js';
import type {
  CompactOptions,
  CompactResult,
  Message,
  ResolvedCompactOptions,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  preserveRecentMessages: 6,
  resultBudgetChars: 60_000,
  keepUnderChars: 600,
  headChars: 400,
  tailChars: 200,
  dropSupersededCalls: true,
  readTools: [],
  writeTools: [],
};

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    preserveRecentMessages: Math.max(
      0,
      Math.floor(finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages)),
    ),
    resultBudgetChars: Math.max(0, finite(options.resultBudgetChars, DEFAULT_OPTIONS.resultBudgetChars)),
    keepUnderChars: Math.max(0, finite(options.keepUnderChars, DEFAULT_OPTIONS.keepUnderChars)),
    headChars: Math.max(0, Math.floor(finite(options.headChars, DEFAULT_OPTIONS.headChars))),
    tailChars: Math.max(0, Math.floor(finite(options.tailChars, DEFAULT_OPTIONS.tailChars))),
    dropSupersededCalls: options.dropSupersededCalls ?? DEFAULT_OPTIONS.dropSupersededCalls,
    readTools: options.readTools ?? DEFAULT_OPTIONS.readTools,
    writeTools: options.writeTools ?? DEFAULT_OPTIONS.writeTools,
  };
}

/** How much of the transcript the compaction removed, by characters. */
export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function textOf(messages: readonly Message[]): string {
  const answered = new Set<string>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) answered.add(result.tool_use_id);
  }
  const parts: string[] = [];
  for (const message of messages) {
    parts.push(message.text);
    for (const tool of message.toolUses) {
      try {
        parts.push(JSON.stringify(tool.input));
      } catch {
        parts.push('');
      }
      if (typeof tool.text === 'string' && !answered.has(tool.tool_use_id)) parts.push(tool.text);
    }
    for (const result of message.toolResults ?? []) parts.push(result.text);
  }
  return parts.join('\n');
}

/**
 * Compacts a transcript by deleting stale tool output, never by rewriting it.
 * Pure and synchronous: no model, no network, no key, nothing leaves the
 * process. Everything kept is byte-for-byte what it was.
 */
export function compact(messages: readonly Message[], options: CompactOptions = {}): CompactResult {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved);
  const decisions = planDecisions(calls, resolved);
  const kept = applyDecisions(messages, calls, decisions, resolved);
  const charsBefore = transcriptChars(messages);
  const charsAfter = transcriptChars(kept);
  const count = (action: string): number => decisions.filter((d) => d.action === action).length;
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter,
      tokensBefore: estimateTokens(textOf(messages)),
      tokensAfter: estimateTokens(textOf(kept)),
      calls: calls.length,
      pinned: decisions.filter((d) => d.reason === 'pinned').length,
      kept: count('keep'),
      resultsTruncated: count('truncate_result'),
      callsDropped: count('drop_call'),
      ms: Date.now() - started,
    },
  };
}
