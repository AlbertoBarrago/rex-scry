import { spawnSync } from 'node:child_process';
import { location, openLocation, validateTarget, which } from '../open.js';
import { clearRuns, cursorOf, updateState } from '../store.js';
import type { Diagnostic, Workspace } from '../types.js';

/** A line for the panel's status bar. */
export interface Status {
  text: string;
  tone: 'ok' | 'warn' | 'error';
}

/**
 * Opens a diagnostic from the panel. Only rex-nvim is used: an editor started
 * from here would fight the panel for the terminal. Without rex-nvim the
 * panel says where the file is instead.
 */
export function openFromPanel(d: Diagnostic, ws: Workspace, stateDir: string): Status {
  let file: string;
  try {
    file = validateTarget(d, ws.root);
  } catch (e) {
    return { text: (e as Error).message, tone: 'error' };
  }
  updateState(ws, (state) => {
    state.cursor = cursorOf(d);
  }, stateDir);
  try {
    openLocation(d, file, process.env, { editor: false });
    return { text: `opened ${location(d, d.relativeFile ?? file)}`, tone: 'ok' };
  } catch (e) {
    return { text: `${(e as Error).message}: ${location(d, file)}`, tone: 'warn' };
  }
}

/** The clipboard programs tried, in order, with their arguments. */
const CLIPBOARDS: ReadonlyArray<readonly [string, ...string[]]> = [
  ['pbcopy'],
  ['wl-copy'],
  ['xclip', '-selection', 'clipboard'],
  ['xsel', '--clipboard', '--input'],
];

/** Copies text with the first clipboard program found (pbcopy on macOS, wl-copy/xclip/xsel on Linux). */
export function copy(text: string): Status {
  for (const [program, ...args] of CLIPBOARDS) {
    const bin = which(program);
    if (!bin) continue;
    const r = spawnSync(bin, args, { input: text, stdio: ['pipe', 'ignore', 'pipe'], timeout: 5000 });
    if (r.status === 0) return { text: 'copied to the clipboard', tone: 'ok' };
    return { text: `${program} failed: ${r.error?.message ?? r.stderr.toString().trim() ?? `exit ${r.status}`}`, tone: 'error' };
  }
  return { text: 'no clipboard program found (pbcopy, wl-copy, xclip, xsel)', tone: 'warn' };
}

/** `FILE:LINE:COL: severity: message [code]`, the same line `list --format plain` prints. */
export function plainLine(d: Diagnostic): string {
  const code = d.code ? ` [${d.code}]` : '';
  return `${location(d)}: ${d.severity}: ${d.message.replace(/\s*\n\s*/g, ' ')}${code}`;
}

export function clearAll(ws: Workspace, stateDir: string): Status {
  try {
    const n = clearRuns(ws, undefined, stateDir);
    return { text: `cleared ${n} run${n === 1 ? '' : 's'}`, tone: 'ok' };
  } catch (e) {
    return { text: (e as Error).message, tone: 'error' };
  }
}
