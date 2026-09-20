export type Role = 'user' | 'assistant';

/** A tool_use block of an assistant message; `text`/`isError` mirror the outcome. */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/**
 * One transcript message. A subset of Claude Code's `SessionMessage`, so a
 * session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/**
 * What the call did to the world, which decides whether its RECORD may be
 * deleted. `read` is re-runnable and leaves no trace; `write` changed
 * something and its record is the only evidence; `unknown` is anything we
 * cannot classify and is treated as `write`.
 */
export type Effect = 'read' | 'write' | 'unknown';

export interface ToolCall {
  /** Short id used in decisions and the log (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  effect: Effect;
  /** Subject of the call: a file path, or the tool plus its exact input. */
  target: string;
  /** The file this call reads or writes, '' when it is not file-shaped. */
  path: string;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block; -1 when the outcome rides on the tool_use. */
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
}

export type CallAction = 'keep' | 'truncate_result' | 'drop_call';

export type DecisionReason =
  /** In a pinned message. */
  | 'pinned'
  /** Nothing applied to it. */
  | 'kept'
  /** Its result is short enough that cutting it saves nothing. */
  | 'small_result'
  /** A later call read or wrote the same file, so this output is stale. */
  | 'superseded'
  /** An identical call was made later. */
  | 'duplicate'
  /** Older than the verbatim output budget. */
  | 'over_budget';

export interface CallDecision {
  id: string;
  tool: string;
  target: string;
  effect: Effect;
  action: CallAction;
  reason: DecisionReason;
  /** Result characters before the decision. */
  chars: number;
  /** Characters the decision removes. */
  savedChars: number;
}

export interface CompactOptions {
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Characters of tool output kept verbatim, newest first. Default 60000. */
  resultBudgetChars?: number;
  /** Results at or below this size are never touched. Default 600. */
  keepUnderChars?: number;
  /** Characters kept from the head of a cut result. Default 400. */
  headChars?: number;
  /** Characters kept from its tail. Default 200. */
  tailChars?: number;
  /** Remove a superseded read call entirely instead of only its output. Default true. */
  dropSupersededCalls?: boolean;
  /** Tool names to force-classify, on top of the built-in taxonomy. */
  readTools?: readonly string[];
  writeTools?: readonly string[];
}

export interface ResolvedCompactOptions {
  preserveRecentMessages: number;
  resultBudgetChars: number;
  keepUnderChars: number;
  headChars: number;
  tailChars: number;
  dropSupersededCalls: boolean;
  readTools: readonly string[];
  writeTools: readonly string[];
}

export interface CompactStats {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  /** Rough token figures for the same two numbers; an estimate, not a tokenizer. */
  tokensBefore: number;
  tokensAfter: number;
  calls: number;
  pinned: number;
  kept: number;
  resultsTruncated: number;
  callsDropped: number;
  ms: number;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  stats: CompactStats;
}
