import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

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

/**
 * Maps the library's output back onto session messages. Anything that came
 * back unchanged is the engine's own object, handle included; anything
 * rebuilt is a fresh message without a handle, so the engine takes the edited
 * content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message as Message, message);
    for (const tool of message.toolUses) uses.set(tool as ToolUse, tool);
    for (const result of message.toolResults ?? []) results.set(result as ToolResult, result);
  }
  return output.map((message) => {
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
    .filter((decision) => decision.action !== 'keep')
    .map(
      (decision) =>
        `${decision.id}:${decision.tool}:${decision.action}/${decision.reason}/-${decision.savedChars}ch`,
    );
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
      const messages = toSessionMessages(event.messages, result.messages);
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
