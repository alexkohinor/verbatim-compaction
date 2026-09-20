import { cutText } from './plan.js';
import type {
  CallDecision,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolResult,
  ToolUse,
} from './types.js';

/**
 * Characters a transcript costs: message text, tool inputs, and every
 * outcome exactly once — from the tool_result when there is one, otherwise
 * from the text the transcript left on the tool_use.
 */
export function transcriptChars(messages: readonly Message[]): number {
  const answered = new Set<string>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) answered.add(result.tool_use_id);
  }
  let total = 0;
  for (const message of messages) {
    total += message.text.length;
    for (const tool of message.toolUses) {
      try {
        total += JSON.stringify(tool.input).length;
      } catch {
        total += 20;
      }
      if (!answered.has(tool.tool_use_id)) total += tool.text?.length ?? 0;
    }
    for (const result of message.toolResults ?? []) total += result.text.length;
  }
  return total;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result, so no result is ever left without its call; a cut
 * result keeps its head and tail with a note between them. A message left
 * with nothing at all is removed; a message nothing touched is returned as the
 * object it came in as, so a host that stamped it keeps its handle.
 */
export function applyDecisions(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  decisions: readonly CallDecision[],
  options: Pick<ResolvedCompactOptions, 'headChars' | 'tailChars'>,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  if (actions.size === 0) return [...messages];

  const cut = (text: string, isError: boolean): string =>
    cutText(text, isError, options.headChars, options.tailChars);

  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }

    let changed = false;
    const toolUses: ToolUse[] = [];
    for (const tool of message.toolUses) {
      const action = actions.get(tool.tool_use_id);
      if (action === 'drop_call') {
        changed = true;
        continue;
      }
      if (action === 'truncate_result' && typeof tool.text === 'string') {
        const text = cut(tool.text, tool.isError ?? false);
        if (text !== tool.text) {
          changed = true;
          const copy: ToolUse = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input, text };
          if (tool.isError) copy.isError = true;
          toolUses.push(copy);
          continue;
        }
      }
      toolUses.push(tool);
    }

    const toolResults: ToolResult[] = [];
    for (const result of message.toolResults ?? []) {
      const action = actions.get(result.tool_use_id);
      if (action === 'drop_call') {
        changed = true;
        continue;
      }
      if (action === 'truncate_result') {
        const text = cut(result.text, result.isError ?? false);
        if (text !== result.text) {
          changed = true;
          const copy: ToolResult = { tool_use_id: result.tool_use_id, text };
          if (result.isError !== undefined) copy.isError = result.isError;
          toolResults.push(copy);
          continue;
        }
      }
      toolResults.push(result);
    }

    if (!changed) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) continue;
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}
