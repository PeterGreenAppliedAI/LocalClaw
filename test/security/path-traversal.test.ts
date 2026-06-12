import { describe, it, expect } from 'vitest';
import { resolve, join, relative, isAbsolute } from 'node:path';

/**
 * Path traversal tests for file containment.
 * Uses path.relative() — cross-platform safe (POSIX + Windows).
 */

function isContained(fullPath: string, workspace: string): boolean {
  const rel = relative(resolve(workspace), fullPath);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

describe('File containment (startsWith fix)', () => {
  const workspace = '/data/workspaces/main';

  it('allows paths within workspace', () => {
    expect(isContained(resolve(workspace, 'file.txt'), workspace)).toBe(true);
    expect(isContained(resolve(workspace, 'subdir/file.txt'), workspace)).toBe(true);
    expect(isContained(resolve(workspace, 'deep/nested/path/file.md'), workspace)).toBe(true);
  });

  it('blocks parent directory traversal', () => {
    const fullPath = resolve(workspace, '../../etc/passwd');
    expect(isContained(fullPath, workspace)).toBe(false);
  });

  it('blocks sibling-prefix escape (main2 when workspace is main)', () => {
    // This is the specific bug the fix addresses
    const siblingPath = resolve('/data/workspaces/main2/secret.txt');
    expect(isContained(siblingPath, workspace)).toBe(false);
  });

  it('blocks absolute path outside workspace', () => {
    expect(isContained('/etc/passwd', workspace)).toBe(false);
    expect(isContained('/tmp/evil.sh', workspace)).toBe(false);
  });

  it('blocks single dot-dot traversal', () => {
    const fullPath = resolve(workspace, '../other-workspace/file.txt');
    expect(isContained(fullPath, workspace)).toBe(false);
  });

  it('blocks deeply nested traversal', () => {
    const fullPath = resolve(workspace, 'a/b/c/../../../../etc/shadow');
    expect(isContained(fullPath, workspace)).toBe(false);
  });
});

describe('Session route sanitization', () => {
  // Mirrors the sanitizePath function from console/handlers/sessions.ts
  function sanitizePath(input: string): string {
    return input.replace(/\.\./g, '').replace(/[/\\]/g, '_');
  }

  it('strips dot-dot sequences', () => {
    expect(sanitizePath('../../../etc')).toBe('___etc'); // dots removed, slashes → underscores
    expect(sanitizePath('..')).toBe('');
    expect(sanitizePath('..%2F..%2F')).toBe('%2F%2F'); // URL-encoded slashes stay but dots removed
  });

  it('replaces path separators with underscores', () => {
    expect(sanitizePath('a/b/c')).toBe('a_b_c');
    expect(sanitizePath('a\\b\\c')).toBe('a_b_c');
  });

  it('preserves normal agent IDs', () => {
    expect(sanitizePath('main')).toBe('main');
    expect(sanitizePath('agent-1')).toBe('agent-1');
    expect(sanitizePath('my_agent')).toBe('my_agent');
  });

  it('handles empty and single-char inputs', () => {
    expect(sanitizePath('')).toBe('');
    expect(sanitizePath('.')).toBe('.');
    expect(sanitizePath('a')).toBe('a');
  });

  it('combined traversal + separator attack', () => {
    expect(sanitizePath('../../etc/passwd')).toBe('__etc_passwd'); // dots removed, separators → underscores
    expect(sanitizePath('..\\..\\windows\\system32')).toBe('__windows_system32');
  });

  it('sanitized path stays within base directory', () => {
    const baseDir = resolve('/data/sessions');
    const agentId = sanitizePath('../../../etc');
    const targetDir = resolve(join(baseDir, agentId));
    expect(targetDir.startsWith(baseDir + '/')).toBe(true);
  });
});
