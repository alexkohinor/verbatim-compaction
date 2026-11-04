import { NOTE_PREFIX } from './plan.js';

function inputNote(omitted: number): string {
  return `${NOTE_PREFIX} ${omitted} chars of this input; the call ran with the full text]`;
}

function cutString(text: string, headChars: number, tailChars: number): string {
  const omitted = text.length - headChars - tailChars;
  const note = inputNote(omitted);
  if (omitted <= note.length) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  const tail = tailChars > 0 ? `\n${text.slice(text.length - tailChars)}` : '';
  return `${head}${note}${tail}`;
}

function cutValue(value: unknown, keepUnderChars: number, headChars: number, tailChars: number): unknown {
  if (typeof value === 'string') {
    return value.length > keepUnderChars ? cutString(value, headChars, tailChars) : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = cutValue(item, keepUnderChars, headChars, tailChars);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = cutValue(item, keepUnderChars, headChars, tailChars);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * The call's input with every string field longer than `keepUnderChars` cut to
 * head and tail, at any depth (MultiEdit's `edits` included). Keys, numbers,
 * booleans and short strings — the path, the pattern, the flags — are kept as
 * they were; the input object itself when nothing was cut.
 */
export function cutInput(
  input: Record<string, unknown>,
  keepUnderChars: number,
  headChars: number,
  tailChars: number,
): Record<string, unknown> {
  return cutValue(input, keepUnderChars, headChars, tailChars) as Record<string, unknown>;
}

export function jsonChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 20;
  }
}
