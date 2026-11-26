import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { which } from './open.js';
import { readState, stateDir, statePath } from './store.js';
import { resolveWorkspace } from './workspace.js';

type Level = 'ok' | 'warn' | 'fail';

/**
 * Reports what works and what is missing. Only `fail` (rex-scry
 * itself cannot work) makes it exit non-zero: Rex, rex-nvim and nvim are
 * optional.
 */
export function doctor(args: string[]): number {
  const { values } = parseArgs({ args, options: { cwd: { type: 'string', short: 'C' } }, strict: true });
  const results: Array<[Level, string]> = [];
  const check = (level: Level, text: string): void => {
    results.push([level, text]);
  };

  const major = Number(process.versions.node.split('.')[0]);
  check(major >= 22 ? 'ok' : 'fail', `node ${process.versions.node}${major >= 22 ? '' : ' (needs 22 or later)'}`);

  const dir = stateDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
    check('ok', `state directory ${dir}`);
  } catch (e) {
    check('fail', `state directory ${dir} is not writable: ${(e as Error).message}`);
  }

  const ws = resolveWorkspace(values.cwd ?? process.cwd());
  check('ok', `workspace ${ws.root} (${ws.workspaceId})`);
  try {
    const state = readState(ws);
    const live = state.runs.reduce((n, r) => n + r.diagnostics.length, 0);
    check('ok', `${state.runs.length} run(s), ${live} stored diagnostic(s) in ${statePath(ws)}`);
  } catch (e) {
    check('fail', (e as Error).message);
  }

  const rex = which('rex');
  check(rex ? 'ok' : 'warn', rex ? `rex CLI ${rex}` : 'rex CLI not in PATH (needed only for the Rex action)');
  check(
    process.env.REX_BLOCK ? 'ok' : 'warn',
    process.env.REX_BLOCK ? `inside a Rex pane (${process.env.REX_BLOCK})` : 'not inside a Rex pane: runs are recorded without a pane id',
  );

  const config = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'rex');
  const luaInstalled = existsSync(join(config, 'rex-scry.lua'));
  let required = false;
  try {
    required = /require\s*\(?\s*["']rex-scry["']/.test(readFileSync(join(config, 'init.lua'), 'utf8'));
  } catch {
    // no init.lua
  }
  check(
    luaInstalled && required ? 'ok' : 'warn',
    luaInstalled && required
      ? 'Rex action installed (rex-scry.lua required from init.lua)'
      : 'Rex action not installed: see README, "Rex action"',
  );

  const rexNvim = which('rex-nvim');
  check(rexNvim ? 'ok' : 'warn', rexNvim ? `rex-nvim ${rexNvim}: open jumps into Neovim in Rex` : 'rex-nvim not in PATH: open falls back to $VISUAL/$EDITOR');
  const nvim = which('nvim');
  check(nvim ? 'ok' : 'warn', nvim ? `nvim ${nvim}` : 'nvim not in PATH: quickfix integration unavailable');
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!rexNvim) check(editor ? 'ok' : 'warn', editor ? `editor fallback: ${editor}` : 'no $VISUAL/$EDITOR: open can only print the location');

  for (const [level, text] of results) process.stdout.write(`${level.padEnd(4)}  ${text}\n`);
  return results.some(([l]) => l === 'fail') ? 1 : 0;
}
