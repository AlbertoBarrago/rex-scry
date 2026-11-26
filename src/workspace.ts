import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Workspace } from './types.js';

/**
 * Physical path with the on-disk spelling: macOS file systems are usually
 * case-insensitive, and Rex reports a terminal's cwd as typed
 * (`~/projects/x` for `~/Projects/x`), so two spellings must give one id.
 * rex-nvim compares physical paths too.
 */
export function physicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The workspace of a directory: the nearest enclosing Git checkout (a `.git`
 * directory, or a `.git` file in a worktree), else the directory itself.
 * Diagnostics are stored and listed per workspace, so builds in different
 * projects never mix.
 */
export function resolveWorkspace(dir: string): Workspace {
  const start = physicalPath(dir);
  let current = start;
  for (;;) {
    if (existsSync(join(current, '.git'))) return { root: current, workspaceId: workspaceIdOf(current) };
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { root: start, workspaceId: workspaceIdOf(start) };
}

export function workspaceIdOf(root: string): string {
  return `ws_${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
}
