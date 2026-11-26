import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { describe, it } from 'node:test';
import {
  clearRuns,
  currentDiagnostics,
  finishRun,
  MAX_RUNS,
  MAX_RUN_AGE_MS,
  readState,
  startRun,
  statePath,
  stepCursor,
  updateState,
} from '../src/store.js';
import type { Diagnostic, Run } from '../src/types.js';
import { resolveWorkspace } from '../src/workspace.js';
import { parse, tempDir, workspace } from './helpers.js';

/** Times are offsets from now: runs older than MAX_RUN_AGE_MS are not returned, even by reads. */
const T0 = Date.now();

function run(runId: string, key: string, startedAt: number): Run {
  return { runId, commandKey: key, command: ['x'], cwd: '/w', pid: process.pid, host: hostname(), startedAt: T0 + startedAt, status: 'running', dropped: 0, diagnostics: [] };
}

function diags(text: string, runId: string, root = '/w'): Diagnostic[] {
  return parse(text, { cwd: root, runId });
}

const ERR_A = "src/a.ts(1,1): error TS1: a\n";
const ERR_B = "src/b.ts(2,2): error TS2: b\n";

describe('run lifecycle', () => {
  it('records start and finish, then supersedes older runs of the same command', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    startRun(ws, run('r1', 'build', 1), dir);
    assert.equal(readState(ws, dir).runs[0]!.status, 'running');
    finishRun(ws, 'r1', { status: 'completed', endedAt: T0 + 2, exitCode: 1, diagnostics: diags(ERR_A + ERR_B, 'r1'), dropped: 0 }, dir);
    assert.equal(currentDiagnostics(readState(ws, dir)).length, 2);

    // Second build: b is fixed. The first run's diagnostics stay visible until it finishes.
    startRun(ws, run('r2', 'build', 3), dir);
    assert.equal(currentDiagnostics(readState(ws, dir)).length, 2);
    const res = finishRun(ws, 'r2', { status: 'completed', endedAt: T0 + 4, exitCode: 1, diagnostics: diags(ERR_A, 'r2'), dropped: 0 }, dir);
    assert.deepEqual(res, { kept: true, superseded: ['r1'], replacedDiagnostics: 2 });
    const now = currentDiagnostics(readState(ws, dir));
    assert.deepEqual(now.map((d) => [d.file.endsWith('a.ts'), d.runId]), [[true, 'r2']]);
  });

  it('leaves runs of other commands alone', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    startRun(ws, run('tsc', 'tsc', 1), dir);
    finishRun(ws, 'tsc', { status: 'completed', endedAt: T0 + 2, diagnostics: diags(ERR_A, 'tsc'), dropped: 0 }, dir);
    startRun(ws, run('lint', 'eslint', 3), dir);
    finishRun(ws, 'lint', { status: 'completed', endedAt: T0 + 4, diagnostics: diags(ERR_B, 'lint'), dropped: 0 }, dir);
    assert.equal(currentDiagnostics(readState(ws, dir)).length, 2);
  });

  it('drops the results of an older run that finishes after a newer one of the same command', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    startRun(ws, run('a', 'build', 1), dir);
    startRun(ws, run('b', 'build', 1)/* same millisecond */, dir);
    finishRun(ws, 'b', { status: 'completed', endedAt: T0 + 2, exitCode: 0, diagnostics: [], dropped: 0 }, dir);
    const res = finishRun(ws, 'a', { status: 'completed', endedAt: T0 + 3, exitCode: 1, diagnostics: diags(ERR_A, 'a'), dropped: 0 }, dir);
    assert.equal(res.kept, false);
    assert.deepEqual(readState(ws, dir).runs.map((r) => r.runId), ['b']);
    assert.equal(currentDiagnostics(readState(ws, dir)).length, 0);
  });

  it('records interrupted runs and keeps their partial diagnostics', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    startRun(ws, run('r1', 'k', 1), dir);
    finishRun(ws, 'r1', { status: 'interrupted', endedAt: T0 + 2, exitCode: 130, signal: 'SIGINT', diagnostics: diags(ERR_A, 'r1'), dropped: 0 }, dir);
    const r = readState(ws, dir).runs[0]!;
    assert.equal(r.status, 'interrupted');
    assert.equal(r.signal, 'SIGINT');
    assert.equal(r.diagnostics.length, 1);
  });

  it('marks a run whose wrapper died as interrupted', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    startRun(ws, { ...run('r1', 'k', 1), pid: 2 ** 22 + 12345 }, dir);
    assert.equal(readState(ws, dir).runs[0]!.status, 'interrupted');
  });

  it('discards the results of a run cleared while it ran', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    startRun(ws, run('done', 'a', 1), dir);
    finishRun(ws, 'done', { status: 'completed', endedAt: T0 + 2, diagnostics: diags(ERR_A, 'done'), dropped: 0 }, dir);
    startRun(ws, run('live', 'b', 3), dir);
    clearRuns(ws, undefined, dir);
    assert.deepEqual(readState(ws, dir).runs.map((r) => r.runId), ['live']);
    clearRuns(ws, 'live', dir);
    const res = finishRun(ws, 'live', { status: 'completed', endedAt: T0 + 4, diagnostics: diags(ERR_B, 'live'), dropped: 0 }, dir);
    assert.equal(res.kept, false);
    assert.equal(currentDiagnostics(readState(ws, dir)).length, 0);
  });
});

describe('cursor', () => {
  it('continues from the position of a diagnostic that was fixed', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    const three = "src/a.ts(1,1): error TS1: a\nsrc/b.ts(1,1): error TS1: b\nsrc/c.ts(1,1): error TS1: c\n";
    startRun(ws, run('r1', 'k', 1), dir);
    finishRun(ws, 'r1', { status: 'completed', endedAt: T0 + 2, diagnostics: diags(three, 'r1'), dropped: 0 }, dir);
    const all = (s: Parameters<typeof currentDiagnostics>[0]) => currentDiagnostics(s);
    assert.match(stepCursor(ws, all, 1, dir)!.diagnostic.file, /a\.ts$/);
    assert.match(stepCursor(ws, all, 1, dir)!.diagnostic.file, /b\.ts$/);
    // b is fixed by the next build: next goes on to c, not back to a.
    startRun(ws, run('r2', 'k', 3), dir);
    finishRun(ws, 'r2', { status: 'completed', endedAt: T0 + 4, diagnostics: diags("src/a.ts(1,1): error TS1: a\nsrc/c.ts(1,1): error TS1: c\n", 'r2'), dropped: 0 }, dir);
    assert.match(stepCursor(ws, all, 1, dir)!.diagnostic.file, /c\.ts$/);
    assert.equal(stepCursor(ws, all, 1, dir), undefined);
  });
});

describe('locking', () => {
  it('takes over a lock left by a process that died', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    const lock = `${statePath(ws, dir)}.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname() }));
    startRun(ws, run('r', 'k', 1), dir);
    assert.equal(readState(ws, dir).runs.length, 1);
    assert.equal(existsSync(lock), false);
  });

  it('makes an existing state directory private', () => {
    const dir = tempDir();
    chmodSync(dir, 0o755);
    startRun(workspace('/w'), run('r', 'k', 1), dir);
    assert.equal(statSync(dir).mode & 0o077, 0);
  });
});

describe('retention', () => {
  it('does not return expired runs even before the next write', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    startRun(ws, run('old', 'k', 1), dir);
    finishRun(ws, 'old', { status: 'completed', endedAt: T0 + 1, diagnostics: diags(ERR_A, 'old'), dropped: 0 }, dir);
    assert.equal(readState(ws, dir, T0 + MAX_RUN_AGE_MS + 10).runs.length, 0);
  });

  it('keeps at most MAX_RUNS runs, dropping the oldest finished ones', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    for (let i = 0; i < MAX_RUNS + 5; i++) {
      startRun(ws, run(`r${i}`, `k${i}`, i + 1), dir);
      finishRun(ws, `r${i}`, { status: 'completed', endedAt: T0 + i + 1, diagnostics: [], dropped: 0 }, dir);
    }
    const runs = readState(ws, dir).runs;
    assert.equal(runs.length, MAX_RUNS);
    assert.equal(runs[0]!.runId, 'r5');
  });

  it('drops finished runs older than the age limit', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    startRun(ws, run('old', 'k', 1), dir);
    finishRun(ws, 'old', { status: 'completed', endedAt: T0 + 1, diagnostics: [], dropped: 0 }, dir);
    updateState(ws, () => undefined, dir, T0 + 1 + MAX_RUN_AGE_MS + 1);
    assert.equal(readState(ws, dir).runs.length, 0);
  });
});

describe('workspaces', () => {
  it('keeps diagnostics of different workspaces apart', () => {
    const dir = tempDir();
    const a = workspace('/projects/a');
    const b = workspace('/projects/b');
    startRun(a, run('ra', 'build', 1), dir);
    finishRun(a, 'ra', { status: 'completed', endedAt: T0 + 2, diagnostics: diags(ERR_A, 'ra', a.root), dropped: 0 }, dir);
    assert.equal(currentDiagnostics(readState(a, dir)).length, 1);
    assert.equal(currentDiagnostics(readState(b, dir)).length, 0);
    assert.notEqual(statePath(a, dir), statePath(b, dir));
  });

  it('resolves a subdirectory to its Git checkout, and one id per physical path', () => {
    const root = tempDir({ '.git/HEAD': '', 'src/deep/x.ts': '' });
    assert.equal(resolveWorkspace(`${root}/src/deep`).root, root);
    assert.equal(resolveWorkspace(`${root}/src/../src/deep`).workspaceId, resolveWorkspace(root).workspaceId);
    const plain = tempDir();
    assert.equal(resolveWorkspace(plain).root, plain);
  });

  it('writes state files readable only by the user', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    startRun(ws, run('r', 'k', 1), dir);
    assert.equal(statSync(statePath(ws, dir)).mode & 0o077, 0);
    assert.equal(existsSync(`${statePath(ws, dir)}.lock`), false);
  });

  it('reports a corrupt state file instead of overwriting it', () => {
    const dir = tempDir();
    const ws = workspace('/w');
    writeFileSync(statePath(ws, dir), '{nope');
    assert.throws(() => readState(ws, dir), /corrupt state file/);
    assert.throws(() => startRun(ws, run('r', 'k', 1), dir), /corrupt state file/);
    assert.equal(readFileSync(statePath(ws, dir), 'utf8'), '{nope');
  });
});
