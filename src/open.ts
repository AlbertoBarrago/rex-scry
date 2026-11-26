import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { insideRoot } from './normalize.js';
import type { Diagnostic } from './types.js';

/** Finds an executable in PATH without a shell. */
export function which(name: string, path = process.env.PATH ?? ''): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * Checks a diagnostic's file before anything opens it. Paths come from
 * untrusted terminal output: the file must exist, be a regular file, and
 * (unless allowed) resolve inside the workspace root after symlinks, so a
 * printed `../../etc/x` or a symlink out of the project is refused.
 */
export function validateTarget(d: Diagnostic, root: string, allowOutside = false): string {
  if (!isAbsolute(d.file)) throw new Error(`refusing to open a relative path: ${d.file}`);
  let real: string;
  try {
    real = realpathSync.native(d.file);
  } catch {
    throw new Error(`file not found: ${d.file}`);
  }
  if (!statSync(real).isFile()) throw new Error(`not a regular file: ${d.file}`);
  if (!allowOutside && insideRoot(real, root) === undefined) {
    throw new Error(`refusing to open ${d.file}: outside the workspace ${root} (pass --allow-outside to open it anyway)`);
  }
  return real;
}

export function location(d: Pick<Diagnostic, 'file' | 'line' | 'column'>, file = d.file): string {
  return `${file}:${d.line}${d.column ? `:${d.column}` : ''}`;
}

export type OpenedWith = 'rex-nvim' | 'editor';

/**
 * The link rex-nvim reads as path + position with no ambiguity:
 * `rex-nvim://open/abs/path?line=N&column=M`, the path percent-encoded.
 * The `FILE:LINE:COL` form is not used: rex-nvim prefers a file that exists
 * under the literal name, so a file named `a.ts:4:10` (or a symlink with that
 * name) would be opened instead of the `a.ts` that was validated.
 */
export function rexNvimUrl(file: string, line: number, column: number | undefined): string {
  const path = file.split('/').map(encodeURIComponent).join('/');
  return `rex-nvim://open${path}?line=${line}${column ? `&column=${column}` : ''}`;
}

/**
 * Splits $EDITOR into a program and its arguments on whitespace, without a
 * shell: `code -w` works, shell syntax does not (and is never evaluated).
 */
function editorArgv(editor: string, file: string, line: number, column: number | undefined): string[] {
  const [program, ...args] = editor.trim().split(/\s+/);
  const name = basename(program!);
  if (/^n?vim?$/.test(name)) return [program!, ...args, `+call cursor(${line},${column ?? 1})`, '--', file];
  if (name === 'code' || name === 'cursor' || name === 'zed') return [program!, ...args, '-g', `${file}:${line}:${column ?? 1}`];
  return [program!, ...args, `+${line}`, file];
}

/**
 * Opens a validated file at its position: through rex-nvim when installed
 * (it finds the right nvim in Rex, or opens one), else with $VISUAL/$EDITOR
 * in this terminal. Every program gets its arguments as a list, never
 * through a shell. Throws when nothing can open it.
 */
export function openLocation(
  d: Diagnostic,
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { editor?: boolean } = {},
): OpenedWith {
  // REX_DIAGNOSTICS_REX_NVIM names the rex-nvim binary; set to an empty string, it disables rex-nvim.
  const rexNvim = env.REX_DIAGNOSTICS_REX_NVIM ?? which('rex-nvim', env.PATH);
  if (rexNvim) {
    const r = spawnSync(rexNvim, ['open', rexNvimUrl(file, d.line, d.column)], { stdio: ['ignore', 'inherit', 'inherit'], env });
    if (r.error) throw new Error(`rex-nvim failed: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`rex-nvim open exited with ${r.status ?? r.signal}`);
    return 'rex-nvim';
  }
  // Callers without a terminal (the Rex action) pass editor: false: an editor needs one.
  const editor = opts.editor === false ? undefined : env.VISUAL || env.EDITOR;
  if (editor) {
    const argv = editorArgv(editor, file, d.line, d.column);
    const r = spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit', env });
    if (r.error) throw new Error(`${argv[0]} failed: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`${argv[0]} exited with ${r.status ?? r.signal}`);
    return 'editor';
  }
  throw new Error(opts.editor === false ? 'rex-nvim not found' : 'nothing to open files with: install rex-nvim or set $EDITOR');
}
