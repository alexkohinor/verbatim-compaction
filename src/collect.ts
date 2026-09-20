import { callTarget, classifyTool, filePath } from './classify.js';
import type { Message, ResolvedCompactOptions, ToolCall, ToolResult } from './types.js';

export function isPinned(index: number, total: number, preserveRecentMessages: number): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
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
          isPinned(callIndex, messages.length, options.preserveRecentMessages) ||
          (resultIndex >= 0 && isPinned(resultIndex, messages.length, options.preserveRecentMessages)),
      });
    }
  });
  return calls;
}
