#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { doctor } from './doctor.js';
import { formatJson, formatPlain, formatText, safe, type GroupBy } from './format.js';
import { location, openLocation, validateTarget } from './open.js';
import { parserIds, selectParsers } from './parsers/index.js';
import { runCommand } from './run.js';
import { clearRuns, currentDiagnostics, cursorOf, ensureStateDir, readState, resetAll, stateDir, statePath, stepCursor, updateState } from './store.js';
import { SEVERITIES, type Diagnostic, type Severity } from './types.js';
import { resolveWorkspace } from './workspace.js';

/** sysexits(3) codes, as rex-nvim uses them. */
const EX_USAGE = 64;
const EX_UNAVAILABLE = 69;

class UsageError extends Error {}

const HELP = `rex-diagnostics: every terminal error, one jump away.

Usage:
  rex-diagnostics run [options] -- COMMAND [ARGS...]   run COMMAND, capture its diagnostics
  rex-diagnostics list [filters] [--json|--format F]  list the workspace's diagnostics
  rex-diagnostics next|prev [filters] [--open]       step through them
  rex-diagnostics open N|ID [filters] [--print]      open one in Neovim (rex-nvim) or $EDITOR
                    [--no-editor] [--allow-outside]
  rex-diagnostics ui [--severity error|warning]       live panel: browse, filter, open, copy, clear
  rex-diagnostics clear [--run ID | --all-workspaces]
  rex-diagnostics path                               print the workspace's state file
  rex-diagnostics doctor                             check the setup

Common options:
  -C, --cwd DIR        act for the workspace of DIR (default: current directory)

run options:
  --parser LIST        only these parsers (${parserIds().join(', ')})
  --key KEY            group runs under KEY instead of cwd + command
  --no-status          do not report progress to Rex (OSC 7501)
  --no-color           do not ask the command for colors
  -q, --quiet          no summary line on stderr

Filters (list, next, prev, open):
  --severity LIST      error,warning,info,hint
  --source LIST        e.g. tsc,eslint
  --file TEXT          path contains TEXT

list options:
  --json               same as --format json
  --format F           text (default), plain (file:line:col: severity: message), json
  --group G            file (default), source, none

The workspace is the enclosing Git checkout, else the directory itself.
State: ${stateDir()}
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

function list(value: string | undefined): string[] | undefined {
  return value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const FILTER_OPTIONS = {
  cwd: { type: 'string', short: 'C' },
  severity: { type: 'string' },
  source: { type: 'string' },
  file: { type: 'string' },
} as const;

interface Filters {
  severity?: string;
  source?: string;
  file?: string;
}

function applyFilters(diags: Diagnostic[], f: Filters): Diagnostic[] {
  const sev = list(f.severity);
  if (sev) {
    const bad = sev.filter((s) => !(SEVERITIES as readonly string[]).includes(s));
    if (bad.length) throw new UsageError(`unknown severity: ${bad.join(', ')} (use ${SEVERITIES.join(', ')})`);
  }
  const src = list(f.source);
  return diags.filter(
    (d) =>
      (!sev || sev.includes(d.severity as Severity)) &&
      (!src || src.includes(d.source)) &&
      (!f.file || d.file.includes(f.file)),
  );
}

/** run options that take a value, for finding where the command starts when `--` is left out. */
const RUN_VALUE_OPTIONS = new Set(['-C', '--cwd', '--parser', '--key']);

/**
 * Splits `run` arguments into its own options and the command. `--` is the
 * unambiguous form; without it the command starts at the first word that is
 * not an option or an option's value (`rex-diagnostics run npm test`).
 */
export function splitRunArgs(args: string[]): { own: string[]; argv: string[] } {
  const sep = args.indexOf('--');
  if (sep !== -1) return { own: args.slice(0, sep), argv: args.slice(sep + 1) };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (RUN_VALUE_OPTIONS.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return { own: args.slice(0, i), argv: args.slice(i) };
  }
  return { own: args, argv: [] };
}

/** Waits until everything written to a stream has been handed to the OS. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) resolve();
    else stream.write('', () => resolve());
  });
}

function cmdRun(args: string[]): Promise<number> {
  const { own, argv } = splitRunArgs(args);
  const { values } = parseArgs({
    args: own,
    options: {
      cwd: { type: 'string', short: 'C' },
      parser: { type: 'string' },
      key: { type: 'string' },
      'no-status': { type: 'boolean' },
      'no-color': { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
    },
    strict: true,
  });
  if (argv.length === 0) throw new UsageError('run needs a command, e.g. rex-diagnostics run -- npm run build');
  let parsers;
  try {
    parsers = selectParsers(list(values.parser));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const cwd = values.cwd ?? process.cwd();
  if (!isDirectory(cwd)) throw new Error(`no such directory: ${cwd}`);
  return runCommand({
    argv,
    cwd,
    workspace: resolveWorkspace(cwd),
    ...(process.env.REX_BLOCK ? { paneId: process.env.REX_BLOCK } : {}),
    parsers,
    stateDir: stateDir(),
    ...(values.key ? { key: values.key } : {}),
    status: !values['no-status'],
    color: !values['no-color'],
    summary: !values.quiet,
  }).then(async (result) => {
    if (result.signal) {
      // Die from the same signal, so the shell sees what the command saw, but
      // only once the last bytes reached the terminal. Signals Node cannot
      // raise on itself (SIGPIPE is ignored) fall back to the 128+N status.
      await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
      process.kill(process.pid, result.signal);
    }
    return result.exitCode;
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function workspaceOf(cwd: string | undefined) {
  const dir = cwd ?? process.cwd();
  if (!isDirectory(dir)) throw new Error(`no such directory: ${dir}`);
  return resolveWorkspace(dir);
}

function loadFiltered(values: Filters & { cwd?: string | undefined }) {
  const ws = workspaceOf(values.cwd);
  const state = readState(ws);
  return { ws, state, diags: applyFilters(currentDiagnostics(state), values) };
}

function cmdList(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { ...FILTER_OPTIONS, json: { type: 'boolean' }, format: { type: 'string' }, group: { type: 'string' } },
    strict: true,
  });
  const format = values.json ? 'json' : (values.format ?? 'text');
  const group = (values.group ?? 'file') as GroupBy;
  if (!['text', 'plain', 'json'].includes(format)) throw new UsageError(`unknown format "${format}" (text, plain, json)`);
  if (!['file', 'source', 'none'].includes(group)) throw new UsageError(`unknown group "${group}" (file, source, none)`);
  const { state, diags } = loadFiltered(values);
  if (format === 'json') process.stdout.write(formatJson(state, diags));
  else if (format === 'plain') process.stdout.write(formatPlain(diags));
  else process.stdout.write(formatText(diags, { color: process.stdout.isTTY === true && !process.env.NO_COLOR, group, runs: state.runs, missing: (f) => !existsSync(f) }));
  return 0;
}

function describe(d: Diagnostic, index: number, total: number): string {
  return `${index + 1}/${total} ${d.severity} ${safe(location(d, d.relativeFile ?? d.file))}  ${safe(d.message.split('\n')[0] ?? '')}\n`;
}

function openOne(d: Diagnostic, root: string, allowOutside: boolean, editor = true): number {
  const file = validateTarget(d, root, allowOutside);
  try {
    openLocation(d, file, process.env, { editor });
  } catch (e) {
    process.stderr.write(`rex-diagnostics: ${safe((e as Error).message)}\n`);
    process.stdout.write(`${safe(location(d, file))}\n`);
    return EX_UNAVAILABLE;
  }
  return 0;
}

function cmdStep(args: string[], direction: 1 | -1): number {
  const { values } = parseArgs({
    args,
    options: { ...FILTER_OPTIONS, open: { type: 'boolean' }, json: { type: 'boolean' }, 'allow-outside': { type: 'boolean' } },
    strict: true,
  });
  const ws = workspaceOf(values.cwd);
  // Validate filters before taking the lock, so a usage error is reported as one.
  applyFilters([], values);
  const step = stepCursor(ws, (state) => applyFilters(currentDiagnostics(state), values), direction);
  if (!step) {
    process.stderr.write(`rex-diagnostics: no ${direction === 1 ? 'next' : 'previous'} diagnostic\n`);
    return 1;
  }
  const d = step.diagnostic;
  if (values.json) process.stdout.write(`${JSON.stringify(d)}\n`);
  else process.stdout.write(describe(d, step.index, step.total));
  return values.open ? openOne(d, ws.root, values['allow-outside'] === true) : 0;
}

function cmdOpen(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    options: { ...FILTER_OPTIONS, 'allow-outside': { type: 'boolean' }, print: { type: 'boolean' }, 'no-editor': { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  const ref = positionals[0];
  if (!ref || positionals.length > 1) throw new UsageError('open takes one diagnostic: its number in `list` or its id');
  const { ws, diags } = loadFiltered(values);
  // An exact id wins; a short number is a position in `list`; anything else is an id prefix.
  let index = diags.findIndex((d) => d.id === ref);
  if (index === -1 && /^\d{1,6}$/.test(ref)) index = Number(ref) - 1;
  else if (index === -1) {
    if (ref.length < 4) throw new UsageError(`"${ref}" is neither a list number nor an id prefix of 4 or more characters`);
    const matches = diags.flatMap((d, i) => (d.id.startsWith(ref) ? [i] : []));
    if (matches.length > 1) throw new UsageError(`id prefix "${ref}" matches ${matches.length} diagnostics`);
    index = matches[0] ?? -1;
  }
  const d = diags[index];
  if (!d) {
    process.stderr.write(`rex-diagnostics: no diagnostic ${safe(ref)}\n`);
    return 1;
  }
  updateState(ws, (state) => {
    state.cursor = cursorOf(d);
  });
  if (values.print) {
    process.stdout.write(`${safe(location(d, validateTarget(d, ws.root, values['allow-outside'] === true)))}\n`);
    return 0;
  }
  return openOne(d, ws.root, values['allow-outside'] === true, !values['no-editor']);
}

function cmdClear(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { cwd: { type: 'string', short: 'C' }, run: { type: 'string' }, 'all-workspaces': { type: 'boolean' } },
    strict: true,
  });
  if (values['all-workspaces']) {
    const n = resetAll();
    process.stderr.write(`rex-diagnostics: removed ${n} workspace${n === 1 ? '' : 's'}\n`);
    return 0;
  }
  const ws = workspaceOf(values.cwd);
  const n = clearRuns(ws, values.run);
  if (values.run && n === 0) {
    process.stderr.write(`rex-diagnostics: no run ${safe(values.run)}\n`);
    return 1;
  }
  return 0;
}

async function cmdUi(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { cwd: { type: 'string', short: 'C' }, severity: { type: 'string' } },
    strict: true,
  });
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new UsageError('ui needs a terminal (use list --json in scripts)');
  const filter = values.severity ?? 'all';
  if (!['all', 'error', 'warning'].includes(filter)) throw new UsageError(`ui --severity takes error or warning, not "${filter}"`);
  const ws = workspaceOf(values.cwd);
  const dir = stateDir();
  ensureStateDir(dir);
  // Ink and React load only here, so `run` and `list` stay fast.
  const { runPanel } = await import('./ui/run.js');
  return runPanel({ workspace: ws, stateDir: dir, filter: filter as 'all' | 'error' | 'warning' });
}

function cmdPath(args: string[]): number {
  const { values } = parseArgs({ args, options: { cwd: { type: 'string', short: 'C' } }, strict: true });
  // Created here so a watcher (the Neovim plugin) can watch the directory before the first run.
  ensureStateDir();
  process.stdout.write(`${statePath(workspaceOf(values.cwd))}\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // `run` handles its own output errors: a closed pipe must not decide its exit status.
  if (command !== 'run') ignoreEpipe();
  try {
    switch (command) {
      case 'run':
        return await cmdRun(rest);
      case 'list':
      case 'ls':
        return cmdList(rest);
      case 'next':
        return cmdStep(rest, 1);
      case 'prev':
        return cmdStep(rest, -1);
      case 'open':
        return cmdOpen(rest);
      case 'clear':
        return cmdClear(rest);
      case 'ui':
        return await cmdUi(rest);
      case 'path':
        return cmdPath(rest);
      case 'doctor':
        return doctor(rest);
      case '--version':
      case '-V':
      case 'version':
        process.stdout.write(`${version()}\n`);
        return 0;
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(HELP);
        return command === undefined ? EX_USAGE : 0;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (e) {
    const err = e as Error & { code?: string };
    const usage = e instanceof UsageError || (typeof err.code === 'string' && err.code.startsWith('ERR_PARSE_ARGS'));
    process.stderr.write(`rex-diagnostics: ${safe(err.message)}\n`);
    if (usage) process.stderr.write('Run `rex-diagnostics help` for usage.\n');
    return usage ? EX_USAGE : 1;
  }
}

/** `rex-diagnostics list | head`: the reader left, nothing to report. */
function ignoreEpipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EPIPE') process.exit(0);
      throw e;
    });
  }
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
