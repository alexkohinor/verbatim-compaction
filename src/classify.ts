import type { Effect, ResolvedCompactOptions } from './types.js';

/**
 * Tools that only observe: re-running them costs time, never correctness, and
 * the transcript is not the only record that they happened.
 */
export const READ_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'BashOutput',
  'TodoRead',
  'ListAgents',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
  'ToolSearch',
];

/**
 * Tools that change something — a file, a process, a remote system, the
 * user's view. Their call record is evidence of a side effect and is never
 * deleted, whatever else has to go.
 */
export const WRITE_TOOLS: readonly string[] = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite',
  'Task',
  'Agent',
  'Artifact',
  'Skill',
  'Workflow',
  'SendMessage',
  'KillShell',
  'CronCreate',
  'CronDelete',
  'PushNotification',
  'RemoteTrigger',
  'ScheduleWakeup',
  'SendFeedback',
  'ReportFindings',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'TaskStop',
  'AskUserQuestion',
];

/** Tools whose subject is a single file, so a later call on it makes an earlier one stale. */
const FILE_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookRead',
  'NotebookEdit',
]);

/** Shell commands that only report. Anything not here is assumed to change something. */
const READ_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd',
  'file', 'stat', 'pwd', 'echo', 'printf', 'which', 'type', 'whoami', 'id', 'date',
  'uname', 'uptime', 'free', 'df', 'du', 'ps', 'top', 'env', 'printenv', 'hostname',
  'jq', 'yq', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk', 'gawk', 'column', 'tree', 'diff', 'cmp', 'basename',
  'dirname', 'realpath', 'readlink', 'md5sum', 'sha1sum', 'sha256sum', 'nl', 'less',
  'more', 'strings', 'xxd', 'base64', 'true', 'false', 'test', 'seq',
]);

/** Subcommands that make an otherwise ambiguous command read-only. */
const READ_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set([
    'status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'rev-list',
    'ls-files', 'ls-remote', 'blame', 'describe', 'shortlog', 'cat-file', 'grep',
    'whatchanged', 'reflog', 'count-objects', 'var', 'help',
  ]),
  docker: new Set(['ps', 'images', 'inspect', 'logs', 'stats', 'version', 'info', 'port', 'top']),
  kubectl: new Set(['get', 'describe', 'logs', 'top', 'explain', 'version', 'api-resources']),
  npm: new Set(['ls', 'list', 'view', 'outdated', 'why', 'ping', 'config']),
  systemctl: new Set(['status', 'list-units', 'list-unit-files', 'is-active', 'is-enabled', 'show', 'cat']),
  gh: new Set(['pr', 'issue', 'repo', 'run', 'api', 'release', 'search']),
};

/** Writing redirections and substitutions we refuse to reason about. */
const UNSAFE_SHELL = /(^|[^0-9&2])>|>>|\$\(|`|\btee\b|\bxargs\b|\bsudo\b|\beval\b/;

function head(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

/**
 * Classifies one shell command. Read-only only when every segment of the
 * pipeline is a known reporting command with no writing redirection; anything
 * else is a write, because guessing wrong costs a deleted side effect.
 */
export function classifyCommand(command: string): Effect {
  const text = command.trim();
  if (!text) return 'unknown';
  if (UNSAFE_SHELL.test(text)) return 'write';
  const segments = text.split(/\|\||&&|;|\||\n/);
  for (const segment of segments) {
    const words = head(segment).filter((word) => !/^[A-Z_][A-Z0-9_]*=/.test(word));
    const [command0, ...rest] = words;
    if (!command0) continue;
    const name = command0.replace(/^.*\//, '');
    if (name === 'sed' && !rest.some((word) => word === '-n' || /^-[a-z]*n/.test(word))) return 'write';
    if (name === 'sed' && rest.some((word) => word.startsWith('-i'))) return 'write';
    if (name === 'find' && rest.some((word) => word === '-delete' || word === '-exec' || word === '-execdir')) {
      return 'write';
    }
    if (name === 'gh' && rest.some((word) => ['create', 'merge', 'close', 'edit', 'delete', 'comment'].includes(word))) {
      return 'write';
    }
    const subcommands = READ_SUBCOMMANDS[name];
    if (subcommands) {
      const subcommand = rest.find((word) => !word.startsWith('-'));
      if (!subcommand || !subcommands.has(subcommand)) return 'write';
      continue;
    }
    if (!READ_COMMANDS.has(name)) return 'write';
  }
  return 'read';
}

export function classifyTool(
  tool: string,
  input: Record<string, unknown>,
  options?: Pick<ResolvedCompactOptions, 'readTools' | 'writeTools'>,
): Effect {
  if (options?.writeTools.includes(tool)) return 'write';
  if (options?.readTools.includes(tool)) return 'read';
  if (tool === 'Bash') {
    const command = input['command'];
    return typeof command === 'string' ? classifyCommand(command) : 'unknown';
  }
  if (WRITE_TOOLS.includes(tool)) return 'write';
  if (READ_TOOLS.includes(tool)) return 'read';
  return 'unknown';
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The file a call reads or writes, '' when it is not file-shaped. */
export function filePath(tool: string, input: Record<string, unknown>): string {
  if (!FILE_TOOLS.has(tool)) return '';
  const raw =
    stringOf(input['file_path']) ??
    stringOf(input['notebook_path']) ??
    stringOf(input['filePath']) ??
    stringOf(input['path']);
  return raw ? raw.replace(/\/+$/, '') : '';
}

function stableStringify(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, Object.keys(input).sort());
  } catch {
    return '[unserialisable]';
  }
}

/**
 * What a later call has to match to make this one stale: the file plus the
 * slice for a file read, the file alone for a file write, and the exact input
 * for everything else — a `Grep` is only superseded by the same `Grep`.
 */
export function callTarget(tool: string, input: Record<string, unknown>, effect: Effect): string {
  const path = filePath(tool, input);
  if (path) {
    if (effect === 'write') return `file:${path}`;
    const offset = input['offset'];
    const limit = input['limit'];
    const slice = offset === undefined && limit === undefined ? '' : `#${String(offset ?? '')}:${String(limit ?? '')}`;
    return `file:${path}${slice}`;
  }
  return `${tool}:${stableStringify(input)}`;
}
