export type Token = { kind: string; value: string };
export type Node = Record<string, unknown>;

export function parseObjectBody(tokens: Token[], at: number): [Node, number] {
  const node: Node = {};
  let i = at;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.kind === 'CLOSE_BRACE') return [node, i + 1];
    if (token.kind === 'COMMA') {
      i += 1;
      continue;
    }
    const key = token.value;
    const value = tokens[i + 1]?.value ?? '';
    node[key] = value;
    i += 2;
  }
  throw new Error('unterminated object');
}

export function parse(tokens: Token[]): Node {
  const [node] = parseObjectBody(tokens, 1);
  return node;
}
