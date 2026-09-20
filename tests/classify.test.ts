import { describe, expect, it } from 'vitest';
import { callTarget, classifyCommand, classifyTool, filePath } from '../src/classify.js';

describe('shell classification', () => {
  it('calls reporting pipelines read-only', () => {
    expect(classifyCommand('ls -la /tmp')).toBe('read');
    expect(classifyCommand('git status --porcelain')).toBe('read');
    expect(classifyCommand('cat a.txt | grep foo | wc -l')).toBe('read');
    expect(classifyCommand('git log --oneline | head -30')).toBe('read');
    expect(classifyCommand('NODE_ENV=test ps -eo args')).toBe('read');
    expect(classifyCommand('sed -n "1,20p" file.ts')).toBe('read');
  });

  it('treats anything that could change the world as a write', () => {
    expect(classifyCommand('rm -rf build')).toBe('write');
    expect(classifyCommand('npm run build')).toBe('write');
    expect(classifyCommand('git commit -m x')).toBe('write');
    expect(classifyCommand('echo hi > file.txt')).toBe('write');
    expect(classifyCommand('cat a.txt >> b.txt')).toBe('write');
    expect(classifyCommand('sed -i s/a/b/ file.ts')).toBe('write');
    expect(classifyCommand('find . -name "*.tmp" -delete')).toBe('write');
    expect(classifyCommand('ls $(cat targets.txt)')).toBe('write');
    expect(classifyCommand('ls | tee out.txt')).toBe('write');
    expect(classifyCommand('curl -X POST https://example.com')).toBe('write');
    expect(classifyCommand('gh pr create --fill')).toBe('write');
    expect(classifyCommand('ls && rm x')).toBe('write');
  });

  it('keeps 2>&1 read-only', () => {
    expect(classifyCommand('git diff 2>&1 | head')).toBe('read');
  });
});

describe('tool classification', () => {
  it('separates observing tools from tools with effects', () => {
    expect(classifyTool('Read', { file_path: '/a.ts' })).toBe('read');
    expect(classifyTool('Grep', { pattern: 'x' })).toBe('read');
    expect(classifyTool('Edit', { file_path: '/a.ts' })).toBe('write');
    expect(classifyTool('Write', { file_path: '/a.ts' })).toBe('write');
    expect(classifyTool('Task', {})).toBe('write');
  });

  it('never calls an unknown tool read-only', () => {
    expect(classifyTool('mcp__server__do_thing', {})).toBe('unknown');
    expect(classifyTool('SomeFutureTool', {})).toBe('unknown');
    expect(classifyTool('Bash', {})).toBe('unknown');
  });

  it('honours explicit overrides', () => {
    const options = { readTools: ['mcp__db__query'], writeTools: ['Read'] };
    expect(classifyTool('mcp__db__query', {}, options)).toBe('read');
    expect(classifyTool('Read', { file_path: '/a.ts' }, options)).toBe('write');
  });
});

describe('targets', () => {
  it('uses the file for file tools and the whole input for the rest', () => {
    expect(filePath('Read', { file_path: '/a.ts' })).toBe('/a.ts');
    expect(filePath('Grep', { pattern: 'x' })).toBe('');
    expect(callTarget('Read', { file_path: '/a.ts' }, 'read')).toBe('file:/a.ts');
    expect(callTarget('Edit', { file_path: '/a.ts', old_string: 'a' }, 'write')).toBe('file:/a.ts');
    expect(callTarget('Grep', { pattern: 'x', path: 'src' }, 'read')).toBe(
      callTarget('Grep', { path: 'src', pattern: 'x' }, 'read'),
    );
  });

  it('separates slices of the same file, so a partial read supersedes only itself', () => {
    expect(callTarget('Read', { file_path: '/a.ts', offset: 100, limit: 50 }, 'read')).not.toBe(
      callTarget('Read', { file_path: '/a.ts' }, 'read'),
    );
  });
});
