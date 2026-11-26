import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, hostname } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { Ingestor } from './pipeline.js';
import type { Parser } from './parsers/types.js';
import { statusSequence, summarize } from './status.js';
import { finishRun, startRun, type FinishResult } from './store.js';
import type { Run, Workspace } from './types.js';

export interface RunOptions {
  argv: string[];
  cwd: string;
  workspace: Workspace;
  paneId?: string;
  parsers: readonly Parser[];
  stateDir: string;
  /** Groups runs for supersession; defaults to cwd + argv. */
  key?: string;
  /** Report progress with OSC 7501 when stdout is a terminal. */
  status: boolean;
  /** Ask the child for colors (it writes into a pipe) when our stdout is a terminal. */
  color: boolean;
  /** Print a one-line summary on stderr when it is a terminal. */
  summary: boolean;
  env?: NodeJS.ProcessEnv;
  stdout?: Writable & { isTTY?: boolean };
  stderr?: Writable & { isTTY?: boolean };
}

export interface RunResult {
  runId: string;
  /** Exit status the wrapper should end with. */
  exitCode: number;
  /** Set when the child died from a signal: the wrapper re-raises it. */
  signal?: NodeJS.Signals;
  diagnostics: number;
}

/**
 * Variables that make common tools keep colors when writing to a pipe. Only
 * set when the user has not set them, and only when our own stdout is a
 * terminal, so `rex-scry run -- x > file` stays plain.
 */
export const COLOR_ENV: Record<string, string> = {
  FORCE_COLOR: '1',
  CLICOLOR_FORCE: '1',
  CARGO_TERM_COLOR: 'always',
  PY_COLORS: '1',
};

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export function commandKey(cwd: string, argv: string[]): string {
  return createHash('sha256').update(JSON.stringify([cwd, ...argv])).digest('hex').slice(0, 16);
}

// Signals that end the wrapper. SIGINT and SIGQUIT from the keyboard already
// reach the child (same foreground process group), so they are not forwarded:
// a second copy makes tools like npm or cargo abort harder than the user asked.
const FORWARDED: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP'];
const OBSERVED: NodeJS.Signals[] = ['SIGINT', 'SIGQUIT', ...FORWARDED];

/**
 * Runs a command with its output passed through untouched (bytes, stream and
 * order per stream) while the parsers read a copy. stdin is inherited, so
 * interactive prompts still work. The run is recorded in the workspace store
 * at start and at end.
 */
export async function runCommand(opts: RunOptions): Promise<RunResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const runId = newRunId();
  const run: Run = {
    runId,
    commandKey: opts.key ?? commandKey(opts.cwd, opts.argv),
    command: opts.argv,
    cwd: opts.cwd,
    ...(opts.paneId ? { paneId: opts.paneId } : {}),
    pid: process.pid,
    host: hostname(),
    startedAt: Date.now(),
    status: 'running',
    dropped: 0,
    diagnostics: [],
  };

  // A closed output pipe (`run -- build | head`) stops our writes to it, never the run.
  const broken = { out: false, err: false };
  stdout.on('error', () => {
    broken.out = true;
  });
  stderr.on('error', () => {
    broken.err = true;
  });
  const warn = (text: string): void => {
    if (!broken.err) stderr.write(text);
  };

  let recording = true;
  try {
    startRun(opts.workspace, run, opts.stateDir);
  } catch (e) {
    // Never break the user's build because the store is unavailable.
    recording = false;
    warn(`rex-scry: cannot record this run: ${(e as Error).message}\n`);
  }

  const showStatus = opts.status && stdout.isTTY === true;
  if (showStatus) stdout.write(statusSequence('working', opts.argv.join(' ')));

  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  // NO_COLOR (https://no-color.org) wins over our wish for colors.
  if (opts.color && stdout.isTTY && !env.NO_COLOR) for (const [k, v] of Object.entries(COLOR_ENV)) env[k] ??= v;

  const ingestor = new Ingestor(opts.parsers, {
    cwd: opts.cwd,
    workspace: opts.workspace,
    runId,
    ...(opts.paneId ? { paneId: opts.paneId } : {}),
  });

  const child = spawn(opts.argv[0]!, opts.argv.slice(1), { cwd: opts.cwd, env, stdio: ['inherit', 'pipe', 'pipe'] });
  let spawned = false;
  child.once('spawn', () => {
    spawned = true;
  });

  let interruptedBy: NodeJS.Signals | undefined;
  const handlers = OBSERVED.map((sig) => {
    const handler = (): void => {
      interruptedBy ??= sig;
      if (FORWARDED.includes(sig) && child.exitCode === null && child.signalCode === null) child.kill(sig);
    };
    process.on(sig, handler);
    return { sig, handler };
  });
  const removeHandlers = (): void => {
    for (const { sig, handler } of handlers) process.off(sig, handler);
  };

  // Parsing must never cost the user their build: if a parser throws on some
  // output, parsing stops for this run and the output keeps flowing.
  let parsing = true;
  const guard = (fn: () => void): void => {
    if (!parsing) return;
    try {
      fn();
    } catch (e) {
      parsing = false;
      warn(`rex-scry: stopped reading diagnostics for this run: ${(e as Error).message}\n`);
    }
  };

  /** Copies a child stream to ours with backpressure, and feeds the parsers. */
  const pipe = (from: Readable, to: Writable, which: 'out' | 'err'): Promise<void> => {
    const sink = ingestor.stream();
    return new Promise((resolve) => {
      from.on('data', (chunk: Buffer) => {
        if (to.destroyed) broken[which] = true;
        // On Linux a pipe write is synchronous: EPIPE is raised inside write(),
        // before any listener added after it could hear it. Pause only when the
        // destination is still alive, or the child's output would stop being read.
        if (!broken[which] && !to.write(chunk) && !broken[which] && !to.destroyed) {
          from.pause();
          const resume = (): void => {
            to.off('drain', resume);
            to.off('error', resume);
            to.off('close', resume);
            from.resume();
          };
          to.once('drain', resume);
          to.once('error', resume);
          to.once('close', resume);
        }
        guard(() => sink.push(chunk));
      });
      from.on('end', () => {
        guard(() => sink.end());
        resolve();
      });
      from.on('error', () => {
        guard(() => sink.end());
        resolve();
      });
    });
  };
  const piped = Promise.all([pipe(child.stdout, stdout, 'out'), pipe(child.stderr, stderr, 'err')]);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: NodeJS.ErrnoException }>(
    (resolve) => {
      child.on('error', (err: NodeJS.ErrnoException) => {
        // After a successful spawn, errors come from child.kill (EPERM): the child is still ours to wait for.
        if (!spawned) resolve({ code: null, signal: null, spawnError: err });
      });
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );
  removeHandlers();

  if (exit.spawnError) {
    const notFound = exit.spawnError.code === 'ENOENT';
    warn(`rex-scry: ${opts.argv[0]}: ${notFound ? 'command not found' : exit.spawnError.message}\n`);
    const exitCode = notFound ? 127 : 126;
    if (recording) record(opts, runId, { status: 'failed_to_start', exitCode }, ingestor, warn);
    if (showStatus && !broken.out) stdout.write(statusSequence('error', `${opts.argv[0]}: ${notFound ? 'command not found' : 'cannot run'}`));
    return { runId, exitCode, diagnostics: 0 };
  }
  await piped;

  const signal = exit.signal ?? undefined;
  const interrupted = signal !== undefined || interruptedBy !== undefined;
  const exitCode = signal ? 128 + (constants.signals[signal] ?? 0) : (exit.code ?? 1);
  const result = recording
    ? record(
        opts,
        runId,
        { status: interrupted ? 'interrupted' : 'completed', exitCode: exit.code ?? exitCode, ...(signal ? { signal } : {}) },
        ingestor,
        warn,
      )
    : undefined;

  const found = ingestor.diagnostics;
  const summary = summarize(found);
  if (showStatus && !broken.out) {
    const state = interrupted ? 'idle' : found.some((d) => d.severity === 'error') ? 'error' : 'done';
    stdout.write(statusSequence(state, `${opts.argv.join(' ')}: ${summary}`));
  }
  if (opts.summary && stderr.isTTY) {
    const replaced = result?.replacedDiagnostics ?? 0;
    if (result && !result.kept && recording) {
      warn('rex-scry: a newer run of this command already finished; these results were discarded\n');
    } else if (found.length > 0) {
      warn(`rex-scry: ${summary} (rex-scry list)\n`);
    } else if (replaced > 0) {
      warn(`rex-scry: no diagnostics (${replaced} from the previous run cleared)\n`);
    }
  }
  return { runId, exitCode, ...(signal ? { signal } : {}), diagnostics: found.length };
}

function record(
  opts: RunOptions,
  runId: string,
  outcome: { status: 'completed' | 'interrupted' | 'failed_to_start'; exitCode: number; signal?: string },
  ingestor: Ingestor,
  warn: (text: string) => void,
): FinishResult | undefined {
  try {
    return finishRun(
      opts.workspace,
      runId,
      { ...outcome, endedAt: Date.now(), diagnostics: ingestor.diagnostics, dropped: ingestor.dropped },
      opts.stateDir,
    );
  } catch (e) {
    warn(`rex-scry: cannot record this run: ${(e as Error).message}\n`);
    return undefined;
  }
}
