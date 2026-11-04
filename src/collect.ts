import { callTarget, classifyTool, filePath } from './classify.js';
import type { Message, ResolvedCompactOptions, ToolCall, ToolResult } from './types.js';

export function isPinned(index: number, total: number, preserveRecentMessages: number): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

type Shape = Pick<Message, 'role' | 'text' | 'toolUses'> & { toolResults?: readonly { tool_use_id: string }[] };

/**
 * Indices where a model response starts — where nothing asked earlier is still
 * waiting for its result. A response's tool calls can be stored as several
 * entries with results between them; a new response cannot start before every
 * call of the last one is answered, so a call entry seen while some call is
 * unanswered belongs to the response already open. A call whose outcome rides
 * on the tool_use and has no result entry anywhere is not waited for.
 */
export function responseStarts(messages: readonly Shape[]): Set<number> {
  const answered = new Set<string>();
  for (const message of messages) for (const r of message.toolResults ?? []) answered.add(r.tool_use_id);
  const starts = new Set<number>();
  const pending = new Set<string>();
  messages.forEach((message, index) => {
    if (pending.size === 0) starts.add(index);
    for (const tool of message.toolUses) if (answered.has(tool.tool_use_id)) pending.add(tool.tool_use_id);
    for (const result of message.toolResults ?? []) pending.delete(result.tool_use_id);
  });
  return starts;
}

/**
 * Where the pinned tail starts: the newest `preserveRecentMessages`, moved back
 * to the start of the response it would otherwise cut — pinning half a response
 * while the other half is rebuilt splits it (bench/RESULTS-writes.md).
 */
export function pinnedTailStart(messages: readonly Shape[], preserveRecentMessages: number): number {
  const target = Math.max(1, messages.length - preserveRecentMessages);
  if (target >= messages.length) return messages.length;
  const starts = responseStarts(messages);
  let start = target;
  while (start > 1 && !starts.has(start)) start -= 1;
  return start;
}

/** The text of a call's outcome, whether the transcript stores it on the result or on the use. */
export function outcomeOf(
  tool: { text?: string; isError?: boolean },
  result: ToolResult | undefined,
): { text: string; isError: boolean } | undefined {
  if (result) return { text: result.text, isError: result.isError ?? false };
  if (typeof tool.text === 'string') return { text: tool.text, isError: tool.isError ?? false };
  return undefined;
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`, classifies it,
 * and marks the pinned ones. A call still in flight (no outcome at all) is
 * never a candidate: there is nothing to cut yet.
 */
export function collectToolCalls(
  messages: readonly Message[],
  options: Pick<ResolvedCompactOptions, 'preserveRecentMessages' | 'readTools' | 'writeTools'>,
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) results.set(result.tool_use_id, { index, result });
  });

  const tailStart = pinnedTailStart(messages, options.preserveRecentMessages);
  const pinned = (index: number): boolean => index === 0 || index >= tailStart;
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      const outcome = outcomeOf(tool, found?.result);
      if (!outcome) continue;
      const effect = classifyTool(tool.tool, tool.input, options);
      const resultIndex = found?.index ?? -1;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        effect,
        target: callTarget(tool.tool, tool.input, effect),
        path: filePath(tool.tool, tool.input),
        callIndex,
        resultIndex,
        resultChars: outcome.text.length,
        isError: outcome.isError,
        pinned:
          pinned(callIndex) || (resultIndex >= 0 && pinned(resultIndex)),
      });
    }
  });
  return calls;
}
