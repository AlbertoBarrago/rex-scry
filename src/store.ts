import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, SEVERITY_RANK, type Diagnostic, type Run, type RunStatus, type Workspace } from './types.js';

/** At most this many runs are kept per workspace; the oldest finished ones go first. */
export const MAX_RUNS = 32;
/** Finished runs older than this are dropped. */
export const MAX_RUN_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Where `next`/`prev` last landed. The position is kept with the id so that
 * when that diagnostic is fixed (its id disappears), the cursor continues
 * from where it was instead of jumping back to the first entry.
 */
export interface Cursor {
  id: string;
  severity: Diagnostic['severity'];
  file: string;
  line: number;
  column?: number;
}

/** Everything stored for one workspace, in one JSON file. */
export interface WorkspaceState {
  schemaVersion: number;
  workspaceId: string;
  root: string;
  updatedAt: number;
  /** Next run sequence number, assigned under the lock: orders runs even when they start in the same millisecond. */
  nextSeq?: number;
  cursor?: Cursor;
  runs: Run[];
}

/**
 * Where state lives: $REX_SCRY_STATE_DIR, else $XDG_STATE_HOME/rex-scry,
 * else ~/.local/state/rex-scry. Only diagnostics and run metadata are
 * stored, never raw terminal output.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REX_SCRY_STATE_DIR) return env.REX_SCRY_STATE_DIR;
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'rex-scry');
}

export function statePath(ws: Workspace, dir = stateDir()): string {
  return join(dir, `${ws.workspaceId}.json`);
}

/**
 * Creates the state directory, or checks an existing one: it must belong to
 * this user, and is made private (0700) if it is not. Another user's
 * directory could redirect writes through planted files.
 */
export function ensureStateDir(dir = stateDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error(`state path ${dir} is not a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`state directory ${dir} belongs to another user`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

function emptyState(ws: Workspace): WorkspaceState {
  return { schemaVersion: SCHEMA_VERSION, workspaceId: ws.workspaceId, root: ws.root, updatedAt: 0, runs: [] };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A run left `running` by a wrapper that was killed outright (SIGKILL, closed
 * pane) would stay running forever: when its pid is gone on this host, it is
 * read as interrupted.
 */
function reconcile(state: WorkspaceState): WorkspaceState {
  const host = hostname();
  for (const run of state.runs) {
    if (run.status === 'running' && run.host === host && !pidAlive(run.pid)) run.status = 'interrupted';
  }
  return state;
}

/** Run order: sequence number when present (assigned under the lock), else start time. */
function order(r: Run): number {
  return r.seq ?? r.startedAt;
}

/**
 * Reads a workspace's state. Retention limits apply to what is returned, so
 * an expired run disappears from `list` without waiting for the next write.
 */
export function readState(ws: Workspace, dir = stateDir(), now = Date.now()): WorkspaceState {
  const path = statePath(ws, dir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(ws);
    throw e;
  }
  let parsed: WorkspaceState;
  try {
    parsed = JSON.parse(text) as WorkspaceState;
  } catch {
    throw new Error(`corrupt state file ${path}: remove it, or run "rex-scry clear --all-workspaces"`);
  }
  if (typeof parsed.schemaVersion !== 'number' || parsed.schemaVersion > SCHEMA_VERSION || !Array.isArray(parsed.runs)) {
    throw new Error(`state file ${path} has schema ${String(parsed.schemaVersion)}, this version reads up to ${SCHEMA_VERSION}`);
  }
  // Cursors from before positions were stored were plain ids.
  if (typeof parsed.cursor === 'string') delete parsed.cursor;
  const state = reconcile(parsed);
  prune(state, now);
  return state;
}

/** Drops runs past the retention limits. Running runs are never dropped. */
export function prune(state: WorkspaceState, now: number): void {
  state.runs = state.runs.filter((r) => r.status === 'running' || now - (r.endedAt ?? r.startedAt) <= MAX_RUN_AGE_MS);
  const finished = state.runs.filter((r) => r.status !== 'running').sort((a, b) => order(a) - order(b));
  const excess = state.runs.length - MAX_RUNS;
  if (excess > 0) {
    const drop = new Set(finished.slice(0, excess).map((r) => r.runId));
    state.runs = state.runs.filter((r) => !drop.has(r.runId));
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
/** A lock whose owner is gone, or older than this, is taken over. */
const LOCK_STALE_MS = 10_000;
/** Longer than LOCK_STALE_MS, so a waiter can always outlast a stale lock. */
const LOCK_WAIT_MS = 15_000;

interface LockOwner {
  pid: number;
  host: string;
}

function readOwner(lock: string): LockOwner | undefined {
  try {
    return JSON.parse(readFileSync(join(lock, 'owner'), 'utf8')) as LockOwner;
  } catch {
    return undefined;
  }
}

/**
 * True when the lock's owner died (same host) or the lock is older than
 * LOCK_STALE_MS. A lock without its owner file yet is only stale by age:
 * its creator may be between mkdir and writing the file.
 */
function isStale(lock: string): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  const owner = readOwner(lock);
  if (owner && owner.host === hostname() && !pidAlive(owner.pid)) return true;
  return age > LOCK_STALE_MS;
}

/**
 * Cross-process lock on one workspace file: wrappers in several panes may
 * finish at the same moment. mkdir is atomic. A stale lock is taken over by
 * renaming it to a name unique to this process first: only one contender's
 * rename succeeds, so two processes can never both remove it and both enter.
 */
function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (isStale(lock)) {
      const claimed = `${lock}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
      try {
        renameSync(lock, claimed);
        rmSync(claimed, { recursive: true, force: true });
      } catch {
        // Another contender claimed it first.
      }
      continue;
    }
    if (Date.now() > deadline) throw new Error(`state file ${path} is locked by another process (lock: ${lock})`);
    Atomics.wait(sleeper, 0, 0, 20);
  }
  try {
    writeExclusive(join(lock, 'owner'), JSON.stringify({ pid: process.pid, host: hostname() } satisfies LockOwner));
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Writes a new file that must not exist (O_EXCL: a planted symlink makes it fail instead of being followed). */
function writeExclusive(path: string, text: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

function writeState(path: string, state: WorkspaceState): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeExclusive(tmp, `${JSON.stringify(state)}\n`);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Reads, changes and atomically rewrites one workspace's state under its lock. */
export function updateState<T>(ws: Workspace, fn: (state: WorkspaceState) => T, dir = stateDir(), now = Date.now()): T {
  ensureStateDir(dir);
  const path = statePath(ws, dir);
  return withLock(path, () => {
    const state = readState(ws, dir, now);
    const result = fn(state);
    prune(state, now);
    state.updatedAt = now;
    state.root = ws.root;
    writeState(path, state);
    return result;
  });
}

/** Records a starting run and gives it the workspace's next sequence number. */
export function startRun(ws: Workspace, run: Run, dir = stateDir()): void {
  updateState(ws, (state) => {
    const seq = state.nextSeq ?? state.runs.reduce((max, r) => Math.max(max, r.seq ?? 0), 0) + 1;
    run.seq = seq;
    state.nextSeq = seq + 1;
    state.runs.push(run);
  }, dir, run.startedAt);
}

export interface FinishResult {
  /**
   * False when the run's results were discarded: it was cleared while it ran,
   * or a newer run of the same command finished first (its results are newer).
   */
  kept: boolean;
  /** Runs this one replaced. */
  superseded: string[];
  /** How many diagnostics the replaced runs held. */
  replacedDiagnostics: number;
}

/**
 * Records a run's outcome and supersedes every older finished run of the
 * same command, so running a build again replaces its diagnostics instead of
 * piling them up. Runs of other commands are left alone. A run that finishes
 * after a newer run of the same command already finished is obsolete: it is
 * dropped, so it cannot bring back errors the newer run no longer reports.
 */
export function finishRun(
  ws: Workspace,
  runId: string,
  outcome: { status: Exclude<RunStatus, 'running'>; endedAt: number; exitCode?: number; signal?: string; diagnostics: Diagnostic[]; dropped: number },
  dir = stateDir(),
): FinishResult {
  return updateState(ws, (state) => {
    const run = state.runs.find((r) => r.runId === runId);
    if (!run) return { kept: false, superseded: [], replacedDiagnostics: 0 };
    const sameKey = state.runs.filter((r) => r.runId !== runId && r.commandKey === run.commandKey && r.status !== 'running');
    if (sameKey.some((r) => order(r) > order(run))) {
      state.runs = state.runs.filter((r) => r.runId !== runId);
      return { kept: false, superseded: [], replacedDiagnostics: 0 };
    }
    run.status = outcome.status;
    run.endedAt = outcome.endedAt;
    run.diagnostics = outcome.diagnostics;
    run.dropped = outcome.dropped;
    if (outcome.exitCode !== undefined) run.exitCode = outcome.exitCode;
    if (outcome.signal !== undefined) run.signal = outcome.signal;
    const replaced = sameKey.filter((r) => order(r) < order(run));
    const ids = new Set(replaced.map((r) => r.runId));
    state.runs = state.runs.filter((r) => !ids.has(r.runId));
    return {
      kept: true,
      superseded: [...ids],
      replacedDiagnostics: replaced.reduce((n, r) => n + r.diagnostics.length, 0),
    };
  }, dir, outcome.endedAt);
}

/** Removes diagnostics: of one run, or of every finished run. Running runs stay (their record), so they can still finish. */
export function clearRuns(ws: Workspace, runId: string | undefined, dir = stateDir()): number {
  return updateState(ws, (state) => {
    const before = state.runs.length;
    state.runs = state.runs.filter((r) => (runId ? r.runId !== runId : r.status === 'running'));
    for (const r of state.runs) if (!runId) r.diagnostics = [];
    delete state.cursor;
    return before - state.runs.length;
  }, dir);
}

/**
 * Deletes every workspace state file (`clear --all-workspaces`), each under
 * its lock, so a run finishing at the same moment cannot write it back.
 */
export function resetAll(dir = stateDir()): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^ws_[0-9a-f]{16}\.json$/.test(name)) continue;
    const path = join(dir, name);
    withLock(path, () => rmSync(path, { force: true }));
    removed++;
  }
  return removed;
}

/** Deterministic order: severity, then file, line, column, then id. */
export function compareDiagnostics(a: Pick<Diagnostic, 'severity' | 'file' | 'line' | 'column' | 'id'>, b: Pick<Diagnostic, 'severity' | 'file' | 'line' | 'column' | 'id'>): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    a.line - b.line ||
    (a.column ?? 0) - (b.column ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The workspace's current diagnostics: those of every kept run, a problem
 * reported by several runs listed once (from the newest run), sorted.
 */
export function currentDiagnostics(state: WorkspaceState): Diagnostic[] {
  const byId = new Map<string, Diagnostic>();
  const runs = [...state.runs].sort((a, b) => order(a) - order(b));
  for (const run of runs) for (const d of run.diagnostics) byId.set(d.id, d);
  return [...byId.values()].sort(compareDiagnostics);
}

/**
 * Moves the `next`/`prev` cursor inside one locked transaction: the list is
 * computed from the state read under the lock, so a rebuild committing in
 * between can never hand back a diagnostic that no longer exists.
 * Returns the diagnostic landed on, its index and the list size, or
 * undefined at either end (or with nothing to step through).
 */
export function stepCursor(
  ws: Workspace,
  select: (state: WorkspaceState) => Diagnostic[],
  direction: 1 | -1,
  dir = stateDir(),
): { diagnostic: Diagnostic; index: number; total: number } | undefined {
  return updateState(ws, (state) => {
    const diags = select(state);
    if (diags.length === 0) return undefined;
    const cur = state.cursor;
    let next: number;
    const at = cur ? diags.findIndex((d) => d.id === cur.id) : -1;
    if (at !== -1) next = at + direction;
    else if (cur) {
      // The diagnostic under the cursor was fixed: continue from its position.
      const after = diags.findIndex((d) => compareDiagnostics(d, cur) > 0);
      const firstAfter = after === -1 ? diags.length : after;
      next = direction === 1 ? firstAfter : firstAfter - 1;
    } else next = direction === 1 ? 0 : diags.length - 1;
    if (next < 0 || next >= diags.length) return undefined;
    const d = diags[next]!;
    state.cursor = cursorOf(d);
    return { diagnostic: d, index: next, total: diags.length };
  }, dir);
}

export function cursorOf(d: Diagnostic): Cursor {
  return { id: d.id, severity: d.severity, file: d.file, line: d.line, ...(d.column ? { column: d.column } : {}) };
}
