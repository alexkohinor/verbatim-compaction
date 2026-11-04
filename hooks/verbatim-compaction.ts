import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { pinnedTailStart } from '../src/collect.js';
import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import type { CompactOptions, CompactResult, Message, ToolResult, ToolUse } from '../src/types.js';

const HOOK_DEFAULTS = {
  /** 0 disables the plugin's own auto-compaction: the engine decides when, as it does without it. */
  compactAtPercent: 0,
  /** Below this the engine's summary is used instead, so the plugin never makes things worse. */
  minReductionRatio: 0.2,
};

export type HookConfig = CompactOptions & {
  compactAtPercent: number;
  minReductionRatio: number;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Record<string, number> = {};
  for (const key of [
    'preserveRecentMessages',
    'resultBudgetChars',
    'keepUnderChars',
    'headChars',
    'tailChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...(numbers as CompactOptions),
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(options, 'minReductionRatio', HOOK_DEFAULTS.minReductionRatio),
  };
  // userConfig has no Infinity: 0 there means «keep every input whole».
  const inputBudget = options['inputBudgetChars'];
  if (typeof inputBudget === 'number' && Number.isFinite(inputBudget)) {
    config.inputBudgetChars = inputBudget <= 0 ? Infinity : inputBudget;
  }
  if (options['dropSupersededCalls'] === false) config.dropSupersededCalls = false;
  return config;
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

function hasTools(message: SessionMessage): boolean {
  return message.toolUses.length > 0 || (message.toolResults?.length ?? 0) > 0;
}

/**
 * Maps the library's output back onto session messages. Anything that came
 * back unchanged is the engine's own object, handle included; anything
 * rebuilt is a fresh message without a handle, so the engine takes the edited
 * content instead of its original.
 *
 * All or none: the engine hands one message per transcript entry, and the tool
 * calls of ONE model response arrive as several entries (with results between
 * them) that share a message id the hook cannot see. A rebuilt entry gets a new
 * id while its handled siblings keep the old one, which splits the response
 * out of order and loses the siblings' results to the model (bench/RESULTS-
 * writes.md). So once any entry is rebuilt, every tool-bearing entry outside the
 * first message and the newest `protectedTail` is rebuilt too — same content,
 * no handle — and no response is left half old, half new.
 *
 * Rebuilt entries each get their own id, so the region is also rebuilt the way
 * the API reads it: one assistant message per response with all its text and
 * calls, then one user message with all its results. An assistant entry seen
 * while a call is unanswered belongs to the open response (a new response
 * cannot start before the last one's results are in); a thinking-only entry
 * carries nothing a rebuilt message can hold and is dropped. The pinned tail
 * starts at a response start (`pinnedTailStart`), so no response is split
 * between the rebuilt region and the untouched tail.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
  protectedTail = 0,
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message as Message, message);
    for (const tool of message.toolUses) uses.set(tool as ToolUse, tool);
    for (const result of message.toolResults ?? []) results.set(result as ToolResult, result);
  }
  const mapped = output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
  if (!mapped.some((message) => message.handle === undefined && hasTools(message))) return mapped;
  // The pinned tail is untouched and never dropped, so it is the same length in
  // the output; its start is moved back past a split response as in collect.
  const tailLength = input.length - pinnedTailStart(input, protectedTail);
  const last = mapped.length - tailLength;

  // Rebuild the region as API messages: one assistant message per response with
  // all its callMsg, then one user message with all its resultMsg.
  const out: SessionMessage[] = [mapped[0]!];
  let callMsg: SessionMessage | undefined;
  let resultMsg: SessionMessage | undefined;
  const pending = new Set<string>();
  const flush = (): void => {
    if (callMsg) out.push(callMsg);
    if (resultMsg) out.push(resultMsg);
    callMsg = undefined;
    resultMsg = undefined;
  };
  for (let index = 1; index < last; index += 1) {
    const message = mapped[index]!;
    const thinkingOnly = message.role === 'assistant' && message.text.length === 0 && !hasTools(message);
    if (message.role === 'assistant') {
      if (pending.size === 0) flush();
      if (thinkingOnly) continue;
      callMsg ??= { role: 'assistant', text: '', toolUses: [] };
      if (message.text) callMsg.text = callMsg.text ? `${callMsg.text}\n${message.text}` : message.text;
      callMsg.toolUses = [...callMsg.toolUses, ...message.toolUses];
      for (const tool of message.toolUses) pending.add(tool.tool_use_id);
      continue;
    }
    if (!message.toolResults?.length) {
      flush();
      pending.clear();
      out.push(message);
      continue;
    }
    resultMsg ??= { role: 'user', text: '', toolUses: [], toolResults: [] };
    if (message.text) resultMsg.text = resultMsg.text ? `${resultMsg.text}\n${message.text}` : message.text;
    resultMsg.toolResults = [...(resultMsg.toolResults ?? []), ...message.toolResults];
    for (const result of message.toolResults) pending.delete(result.tool_use_id);
  }
  flush();
  for (let index = Math.max(1, last); index < mapped.length; index += 1) out.push(mapped[index]!);
  return out;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    `${stats.callsDropped} calls dropped`,
    `${stats.resultsTruncated} results cut`,
    `${stats.kept} kept (${stats.pinned} pinned)`,
  ];
  return `${percent(reductionRatio(result))} smaller, ~${stats.tokensBefore}→${stats.tokensAfter} tokens; ${parts.join(', ')}`;
}

const UI_LOG_MAX_CHARS = 4096;

/** One entry per decision that changed something, chunked under the host's line limit. */
export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = result.decisions
    .filter((decision) => decision.action !== 'keep' || decision.inputAction !== 'keep')
    .map((decision) => {
      const parts: string[] = [];
      if (decision.action !== 'keep') {
        parts.push(`${decision.action}/${decision.reason}/-${decision.savedChars}ch`);
      }
      if (decision.inputAction !== 'keep') parts.push(`truncate_input/-${decision.inputSavedChars}ch`);
      return `${decision.id}:${decision.tool}:${parts.join('+')}`;
    });
  if (entries.length === 0) return ['decisions: (nothing cut)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1 ? `decisions: ${chunk}` : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

export const register: Register = (on: On, options: PluginOptions) => {
  const config = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const result = compact(event.messages as readonly Message[], config);
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        const text = `verbatim-compaction: built-in summary instead (only ${summarize(result)})`;
        $.ui.log(text);
        return next(event);
      }
      const messages = toSessionMessages(
        event.messages,
        result.messages,
        resolveOptions(config).preserveRecentMessages,
      );
      const text = `verbatim-compaction: kept ${messages.length}/${event.messages.length} messages verbatim, no summary (${summarize(result)})`;
      $.ui.log(text);
      $.ui.toast(text, { timeoutMs: 15_000 });
      return { messages };
    } catch (error) {
      const text = `verbatim-compaction: built-in summary instead (${
        error instanceof Error ? error.message : String(error)
      })`;
      $.ui.log(text);
      $.ui.toast(text, { timeoutMs: 15_000 });
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (config.compactAtPercent <= 0 || compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < config.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `verbatim-compaction: auto-compact skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
