"""Converts a Claude Code session .jsonl into the Message[] the library takes.

Read-only, local: it never sends anything anywhere.
"""
import json, sys

def convert(path):
    messages = []
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get('type') not in ('user', 'assistant') or o.get('isSidechain'):
            continue
        m = o.get('message') or {}
        role = m.get('role')
        if role not in ('user', 'assistant'):
            continue
        content = m.get('content')
        if isinstance(content, str):
            messages.append({'role': role, 'text': content, 'toolUses': []})
            continue
        if not isinstance(content, list):
            continue
        text, uses, results = [], [], []
        for b in content:
            if not isinstance(b, dict):
                continue
            t = b.get('type')
            if t == 'text':
                text.append(b.get('text') or '')
            elif t == 'thinking':
                text.append(b.get('thinking') or '')
            elif t == 'tool_use':
                uses.append({'tool_use_id': b.get('id'), 'tool': b.get('name') or '',
                             'input': b.get('input') if isinstance(b.get('input'), dict) else {}})
            elif t == 'tool_result':
                c = b.get('content')
                if isinstance(c, list):
                    c = '\n'.join(x.get('text', '') for x in c if isinstance(x, dict))
                results.append({'tool_use_id': b.get('tool_use_id'),
                                'text': c if isinstance(c, str) else json.dumps(c, ensure_ascii=False),
                                'isError': bool(b.get('is_error'))})
        msg = {'role': role, 'text': '\n'.join(text), 'toolUses': uses}
        if results:
            msg['toolResults'] = results
        messages.append(msg)
    return [m for m in messages if m['text'] or m['toolUses'] or m.get('toolResults')]

if __name__ == '__main__':
    json.dump(convert(sys.argv[1]), sys.stdout, ensure_ascii=False)
