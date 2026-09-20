import type { Message } from '../src/types.js';

let counter = 0;

export function resetIds(): void {
  counter = 0;
}

/** An assistant call plus its user result, the shape Claude Code stores. */
export function call(
  tool: string,
  input: Record<string, unknown>,
  output: string,
  isError = false,
): Message[] {
  const tool_use_id = `toolu_${++counter}`;
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id, tool, input, text: output, isError }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id, text: output, isError }] },
  ];
}

/** A call whose outcome the transcript stored on the tool_use only. */
export function inlineCall(
  tool: string,
  input: Record<string, unknown>,
  output: string,
): Message[] {
  const tool_use_id = `toolu_${++counter}`;
  return [{ role: 'assistant', text: '', toolUses: [{ tool_use_id, tool, input, text: output }] }];
}

export function user(text: string): Message {
  return { role: 'user', text, toolUses: [] };
}

export function assistant(text: string): Message {
  return { role: 'assistant', text, toolUses: [] };
}

export function big(chars: number, seed = 'x'): string {
  return seed.repeat(Math.ceil(chars / seed.length)).slice(0, chars);
}

/** Pads a transcript so the calls under test are outside the pinned tail. */
export function padding(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => assistant(`step ${i}`));
}
