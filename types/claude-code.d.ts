/**
 * The slice of Claude Code's function-hook API this plugin uses, hand-written
 * so `npm run typecheck` works without the early-access package installed.
 * At runtime the engine provides the real objects; shapes follow the
 * `claude-code` module of Claude Code 2.1.274.
 */
declare module 'claude-code' {
  export type Role = 'user' | 'assistant';

  export type ToolUseSummary = {
    tool_use_id: string;
    tool: string;
    input: Record<string, unknown>;
    result?: unknown;
    text?: string;
    isError?: true;
  };

  export type ToolResultSummary = {
    tool_use_id: string;
    text: string;
    isError: boolean;
    result?: unknown;
  };

  export type SessionMessage = {
    role: Role;
    text: string;
    toolUses: ToolUseSummary[];
    toolResults?: ToolResultSummary[];
    /** The engine's stamp on a message handed to a `session.compact` hook. */
    handle?: string;
  };

  export type SessionCompactTrigger = string;

  export type SessionCompactInput = {
    trigger: SessionCompactTrigger;
    agentId?: string;
    instructions?: string;
    messages: readonly SessionMessage[];
  };

  export type SessionCompacted = {
    messages: readonly SessionMessage[];
    tokensBefore?: number;
    tokensAfter?: number;
    skip?: undefined;
  };

  export type SessionCompactSkipped = { skip: string };

  export type SessionCompactResult = SessionCompacted | SessionCompactSkipped;

  export type TurnCompleteInput = Record<string, unknown>;

  export type SessionUsage = {
    context: { percent?: number };
  };

  export type Engine = {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
    session: {
      usage: (args?: unknown) => Promise<SessionUsage>;
      compact: (args?: unknown) => Promise<unknown>;
    };
  };

  export type Next<E, R> = (event: E) => Promise<R>;

  export type On = {
    (
      pattern: 'session.compact',
      hook: (
        $: Engine,
        event: SessionCompactInput,
        next: Next<SessionCompactInput, SessionCompactResult>,
      ) => Promise<SessionCompactResult> | SessionCompactResult,
    ): unknown;
    (
      pattern: 'turn.complete',
      hook: (
        $: Engine,
        event: TurnCompleteInput,
        next: Next<TurnCompleteInput, unknown>,
      ) => Promise<unknown>,
    ): unknown;
  };

  export type PluginOptions = Readonly<Record<string, string | number | boolean | readonly string[]>>;

  export type Register = (on: On, options: PluginOptions) => unknown;
}
