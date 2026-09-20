import type { CallDecision, ResolvedCompactOptions, ToolCall } from './types.js';

export const NOTE_PREFIX = '[verbatim-compaction cut';

function noteFor(omitted: number, isError: boolean): string {
  return `${NOTE_PREFIX} ${omitted} chars${isError ? ' of an error' : ''}; re-run the tool if they are needed]`;
}

/** How many characters cutting a result of `chars` would actually save; 0 when it would not. */
export function cutSavings(
  chars: number,
  isError: boolean,
  headChars: number,
  tailChars: number,
): number {
  const omitted = chars - headChars - tailChars;
  const note = noteFor(omitted, isError);
  if (omitted <= note.length) return 0;
  const kept = headChars + (headChars > 0 ? 1 : 0) + note.length + tailChars + (tailChars > 0 ? 1 : 0);
  return Math.max(0, chars - kept);
}

/** The head, the note and the tail of a cut result; `text` unchanged when cutting saves nothing. */
export function cutText(
  text: string,
  isError: boolean,
  headChars: number,
  tailChars: number,
): string {
  const omitted = text.length - headChars - tailChars;
  const note = noteFor(omitted, isError);
  if (omitted <= note.length) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  const tail = tailChars > 0 ? `\n${text.slice(text.length - tailChars)}` : '';
  return `${head}${note}${tail}`;
}

function inputChars(input: Record<string, unknown>): number {
  try {
    return JSON.stringify(input).length;
  } catch {
    return 20;
  }
}

/**
 * Decides what happens to every call, by rules only — no model, no network,
 * no probability. In order:
 *
 * 1. A pinned call is untouched.
 * 2. A call whose subject a later call revisited is stale: the same file read
 *    again or written, or the very same call made again. A read that only
 *    observed is removed whole (the newer call carries the current truth); a
 *    call that changed something keeps its record and loses only its output.
 * 3. What is left is kept verbatim newest first until `resultBudgetChars` is
 *    spent; older output is cut to head and tail.
 *
 * A result no larger than `keepUnderChars` is never cut, because it would not
 * save anything. Nothing is ever rewritten or summarised.
 */
export function planDecisions(
  calls: readonly ToolCall[],
  options: Pick<
    ResolvedCompactOptions,
    'resultBudgetChars' | 'keepUnderChars' | 'headChars' | 'tailChars' | 'dropSupersededCalls'
  >,
): CallDecision[] {
  const lastByTarget = new Map<string, number>();
  const lastWriteByPath = new Map<string, number>();
  calls.forEach((call, index) => {
    lastByTarget.set(call.target, index);
    if (call.path && call.effect === 'write') lastWriteByPath.set(call.path, index);
  });

  const decisions: CallDecision[] = calls.map((call) => ({
    id: call.id,
    tool: call.tool,
    target: call.target,
    effect: call.effect,
    action: 'keep',
    reason: call.pinned ? 'pinned' : 'kept',
    chars: call.resultChars,
    savedChars: 0,
  }));

  calls.forEach((call, index) => {
    if (call.pinned) return;
    const sameTargetLater = (lastByTarget.get(call.target) ?? -1) > index;
    const writtenLater = call.path ? (lastWriteByPath.get(call.path) ?? -1) > index : false;
    if (!sameTargetLater && !writtenLater) return;
    const decision = decisions[index]!;
    decision.reason = sameTargetLater && !call.path ? 'duplicate' : 'superseded';
    if (call.effect === 'read' && options.dropSupersededCalls) {
      decision.action = 'drop_call';
      decision.savedChars = call.resultChars + inputChars(call.input);
    } else {
      decision.action = 'truncate_result';
    }
  });

  let spent = 0;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!;
    const decision = decisions[index]!;
    if (decision.action === 'drop_call') continue;
    if (call.pinned) {
      spent += call.resultChars;
      continue;
    }
    if (decision.action === 'truncate_result') continue;
    if (spent + call.resultChars <= options.resultBudgetChars) {
      spent += call.resultChars;
      continue;
    }
    decision.action = 'truncate_result';
    decision.reason = 'over_budget';
  }

  decisions.forEach((decision, index) => {
    if (decision.action !== 'truncate_result') return;
    const call = calls[index]!;
    if (call.resultChars <= options.keepUnderChars) {
      decision.action = 'keep';
      decision.reason = 'small_result';
      decision.savedChars = 0;
      spent += call.resultChars;
      return;
    }
    decision.savedChars = cutSavings(
      call.resultChars,
      call.isError,
      options.headChars,
      options.tailChars,
    );
    if (decision.savedChars === 0) {
      decision.action = 'keep';
      decision.reason = 'small_result';
    }
  });

  return decisions;
}
