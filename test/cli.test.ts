import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, tempDir } from './helpers.js';

const CLI = join(ROOT, 'src', 'cli.ts');
// Resolved here: `--import tsx` would be looked up from the child's cwd (a temp project).
const TSX = import.meta.resolve('tsx');

interface Env {
  state: string;
  project: string;
  env: NodeJS.ProcessEnv;
}

/** A Git-like project with real source files, and an isolated state dir. */
function setup(files: Record<string, string> = {}): Env {
  const project = tempDir({ '.git/HEAD': '', 'src/user.ts': 'a\nb\nc\nreturn user.name;\n', ...files });
  const state = tempDir();
  const env: NodeJS.ProcessEnv = { ...process.env, REX_DIAGNOSTICS_STATE_DIR: state, NO_COLOR: '1' };
  delete env.REX_BLOCK;
  delete env.VISUAL;
  delete env.EDITOR;
  delete env.REX_DIAGNOSTICS_REX_NVIM;
  // No rex-nvim from the developer's machine: tests pass their own stub when they need one.
  env.PATH = (env.PATH ?? '').split(':').filter((p) => !existsSync(join(p, 'rex-nvim'))).join(':');
  return { state, project, env };
}

function cli(e: Env, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd: e.project,
    env: { ...e.env, ...opts.env },
    encoding: 'utf8',
    input: opts.input ?? '',
  });
}

/** A node one-liner as a command for `run --`. */
const node = (code: string): string[] => [process.execPath, '-e', code];

const TSC_ERR = "src/user.ts(4,10): error TS18048: 'user' is possibly 'undefined'.";

describe('run: transparency', () => {
  it('passes stdout and stderr through unchanged and keeps the exit code', () => {
    const e = setup();
    const r = cli(e, ['run', '--', ...node('process.stdout.write("out\\x1b[31mred\\n"); process.stderr.write("err\\n"); process.exit(3)')]);
    assert.equal(r.status, 3);
    assert.equal(r.stdout, 'out\x1b[31mred\n');
    assert.equal(r.stderr, 'err\n');
  });

  it('passes stdin through', () => {
    const e = setup();
    const r = cli(e, ['run', '--', ...node('process.stdin.pipe(process.stdout)')], { input: 'hello\n' });
    assert.equal(r.stdout, 'hello\n');
    assert.equal(r.status, 0);
  });

  it('exits 127 when the command does not exist, and records the failure', () => {
    const e = setup();
    const r = cli(e, ['run', '--', 'definitely-not-a-command-xyz']);
    assert.equal(r.status, 127);
    assert.match(r.stderr, /command not found/);
    const json = JSON.parse(cli(e, ['list', '--json']).stdout);
    assert.equal(json.runs[0].status, 'failed_to_start');
  });

  it('dies from the signal that killed the command', () => {
    const e = setup();
    const r = cli(e, ['run', '--', ...node('process.kill(process.pid, "SIGTERM")')]);
    assert.equal(r.signal, 'SIGTERM');
    const json = JSON.parse(cli(e, ['list', '--json']).stdout);
    assert.equal(json.runs[0].status, 'interrupted');
    assert.equal(json.runs[0].signal, 'SIGTERM');
  });

  it('forwards SIGTERM to the command and keeps what it printed', async () => {
    const e = setup();
    const child = spawn(
      process.execPath,
      ['--import', TSX, CLI, 'run', '--', ...node(`console.error(${JSON.stringify(TSC_ERR)}); setInterval(() => {}, 1000)`)],
      { cwd: e.project, env: e.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, sig) => resolve(sig)));
    // Ready once the command printed; fail instead of hanging if it exits first or never prints.
    const ready = await Promise.race([
      new Promise<'ready'>((resolve) => child.stderr.once('data', () => resolve('ready'))),
      exited.then(() => 'exited' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20_000).unref()),
    ]);
    assert.equal(ready, 'ready');
    child.kill('SIGTERM');
    const signal = await exited;
    assert.equal(signal, 'SIGTERM');
    const json = JSON.parse(cli(e, ['list', '--json']).stdout);
    assert.equal(json.runs[0].status, 'interrupted');
    assert.equal(json.diagnostics.length, 1);
  });

  it('writes no Rex status sequence when stdout is not a terminal', () => {
    const e = setup();
    const r = cli(e, ['run', '--', ...node('console.log("x")')]);
    assert.equal(r.stdout.includes('\x1b]7501'), false);
  });

  it('rejects a run without a command', () => {
    const e = setup();
    assert.equal(cli(e, ['run']).status, 64);
    assert.equal(cli(e, ['run', '--key', 'k']).status, 64);
    assert.equal(cli(e, ['run', '--parser', 'nope', '--', 'true']).status, 64);
  });

  it('accepts the command without --', () => {
    const e = setup();
    const r = cli(e, ['run', '--key', 'k', '-q', process.execPath, '-e', 'process.exit(6)']);
    assert.equal(r.status, 6);
  });

  it('reports a missing -C directory as such, not as a missing command', () => {
    const e = setup();
    const r = cli(e, ['run', '-C', join(e.project, 'nope'), '--', 'true']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no such directory/);
  });

  it('keeps the exit status and the diagnostics when the reader closes the pipe early', async () => {
    const e = setup();
    const code = `for (let i = 0; i < 5000; i++) console.log("line " + i); console.log(${JSON.stringify(TSC_ERR)}); process.exit(5)`;
    const child = spawn(process.execPath, ['--import', TSX, CLI, 'run', '--', ...node(code)], {
      cwd: e.project,
      env: e.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Like `| head -1`: read once, then close our end.
    child.stdout.once('data', () => child.stdout.destroy());
    const status = await new Promise((resolve) => child.once('exit', (c) => resolve(c)));
    assert.equal(status, 5);
    const json = JSON.parse(cli(e, ['list', '--json']).stdout);
    assert.equal(json.runs[0].status, 'completed');
    assert.equal(json.diagnostics.length, 1);
  });

  it('keeps running and keeps the exit status when output breaks a parser', () => {
    const e = setup();
    // A malformed file URL after a Rust header once threw inside the parser and killed the wrapper.
    const r = cli(e, ['run', '--', ...node('console.log("error[E1]: x\\n --> file:///tmp/%ZZ:3:1"); setTimeout(() => { console.log("after"); process.exit(4) }, 100)')]);
    assert.equal(r.status, 4);
    assert.match(r.stdout, /after/);
  });
});

describe('run, list, rerun', () => {
  it('captures, lists, and replaces diagnostics on the next run of the same command', () => {
    const e = setup();
    const build = ['run', '--key', 'build', '--', ...node(`if (!process.env.FIXED) console.error(${JSON.stringify(TSC_ERR)}); process.exit(process.env.FIXED ? 0 : 2)`)];
    assert.equal(cli(e, build).status, 2);

    const json = JSON.parse(cli(e, ['list', '--json']).stdout);
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.workspace.root, e.project);
    assert.deepEqual(json.counts, { error: 1, warning: 0, info: 0, hint: 0 });
    const d = json.diagnostics[0];
    assert.equal(d.file, join(e.project, 'src/user.ts'));
    assert.equal(d.relativeFile, 'src/user.ts');
    assert.deepEqual([d.line, d.column, d.code, d.source, d.severity], [4, 10, 'TS18048', 'tsc', 'error']);
    assert.equal(d.runId, json.runs[0].runId);

    const text = cli(e, ['list']).stdout;
    assert.match(text, /DIAGNOSTICS {2}1 error/);
    assert.match(text, /1 {2}ERROR {4}src\/user\.ts:4:10/);
    assert.equal(cli(e, ['list', '--format', 'plain']).stdout, `${join(e.project, 'src/user.ts')}:4:10: error: 'user' is possibly 'undefined'. [TS18048]\n`);

    // Fixed: the rerun supersedes the first run, nothing stale remains.
    assert.equal(cli(e, build, { env: { FIXED: '1' } }).status, 0);
    const after = JSON.parse(cli(e, ['list', '--json']).stdout);
    assert.equal(after.diagnostics.length, 0);
    assert.equal(after.runs.length, 1);
  });

  it('prints the same JSON for the same state', () => {
    const e = setup();
    cli(e, ['run', '--', ...node(`console.error(${JSON.stringify(TSC_ERR)})`)]);
    assert.equal(cli(e, ['list', '--json']).stdout, cli(e, ['list', '--json']).stdout);
  });

  it('filters by severity and source', () => {
    const e = setup({ 'a.c': '1\n2\n' });
    cli(e, ['run', '--', ...node(`console.error(${JSON.stringify(TSC_ERR)}); console.log("a.c:2:1: warning: unused")`)]);
    const all = JSON.parse(cli(e, ['list', '--json']).stdout).diagnostics;
    assert.equal(all.length, 2);
    const warnings = JSON.parse(cli(e, ['list', '--json', '--severity', 'warning']).stdout).diagnostics;
    assert.deepEqual(warnings.map((d: { source: string }) => d.source), ['generic']);
    assert.equal(cli(e, ['list', '--severity', 'fatal']).status, 64);
  });

  it('lists an empty workspace with an empty state', () => {
    const e = setup();
    const json = JSON.parse(cli(e, ['list', '--json']).stdout);
    assert.deepEqual(json.diagnostics, []);
    assert.match(cli(e, ['list']).stdout, /No diagnostics/);
  });

  it('clears diagnostics', () => {
    const e = setup();
    cli(e, ['run', '--', ...node(`console.error(${JSON.stringify(TSC_ERR)})`)]);
    assert.equal(cli(e, ['clear']).status, 0);
    assert.equal(JSON.parse(cli(e, ['list', '--json']).stdout).diagnostics.length, 0);
    assert.equal(cli(e, ['clear', '--run', 'run_nope']).status, 1);
  });
});

describe('navigation and opening', () => {
  function withTwo(): Env {
    const e = setup({ 'src/b.ts': '1\n2\n3\n' });
    cli(e, ['run', '--', ...node(`console.error(${JSON.stringify(TSC_ERR)}); console.error("src/b.ts(2,1): warning TS1: w")`)]);
    return e;
  }

  /** A fake rex-nvim that records its arguments. */
  function stub(e: Env): string {
    const log = join(e.state, 'rex-nvim.log');
    const bin = join(e.state, 'rex-nvim-stub');
    writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${log}'\n`);
    chmodSync(bin, 0o755);
    return log;
  }

  it('steps through diagnostics with next and prev, stopping at the ends', () => {
    const e = withTwo();
    assert.match(cli(e, ['next']).stdout, /^1\/2 error src\/user\.ts:4:10/);
    assert.match(cli(e, ['next']).stdout, /^2\/2 warning src\/b\.ts:2:1/);
    const end = cli(e, ['next']);
    assert.equal(end.status, 1);
    assert.match(end.stderr, /no next diagnostic/);
    assert.match(cli(e, ['prev']).stdout, /^1\/2 error/);
  });

  it('opens through rex-nvim with an unambiguous rex-nvim:// link, no shell', () => {
    const e = withTwo();
    const log = stub(e);
    const r = cli(e, ['open', '1'], { env: { REX_DIAGNOSTICS_REX_NVIM: join(e.state, 'rex-nvim-stub') } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean), ['open', `rex-nvim://open${join(e.project, 'src/user.ts')}?line=4&column=10`]);
  });

  it('falls back to $EDITOR with the position', () => {
    const e = withTwo();
    const log = stub(e);
    // A rex-nvim on PATH that would fail the test if used: an empty REX_DIAGNOSTICS_REX_NVIM disables it.
    const bin = tempDir({ 'rex-nvim': '#!/bin/sh\nexit 3\n' });
    chmodSync(join(bin, 'rex-nvim'), 0o755);
    const r = cli(e, ['open', '2'], { env: { EDITOR: join(e.state, 'rex-nvim-stub'), REX_DIAGNOSTICS_REX_NVIM: '', PATH: `${bin}:${e.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean), ['+2', join(e.project, 'src/b.ts')]);
  });

  it('prints the location and exits 69 when nothing can open it', () => {
    const e = withTwo();
    const r = cli(e, ['open', '1']);
    assert.equal(r.status, 69);
    assert.equal(r.stdout, `${join(e.project, 'src/user.ts')}:4:10\n`);
  });
});

describe('security', () => {
  it('never runs text found in the output', () => {
    const e = setup();
    const marker = join(e.state, 'pwned');
    const evil = `src/user.ts(4,10): error TS1: $(touch ${marker}) \`touch ${marker}\`; touch ${marker}`;
    cli(e, ['run', '--', ...node(`console.error(${JSON.stringify(evil)})`)]);
    const log = join(e.state, 'args.log');
    const bin = join(e.state, 'editor');
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
    chmodSync(bin, 0o755);
    cli(e, ['list']);
    cli(e, ['open', '1'], { env: { EDITOR: bin } });
    assert.equal(existsSync(marker), false);
  });

  it('refuses to open files outside the workspace, through ../, absolute paths or symlinks', () => {
    const outside = tempDir({ 'secret.txt': 'x\n' });
    const e = setup();
    spawnSync('ln', ['-s', join(outside, 'secret.txt'), join(e.project, 'link.txt')]);
    const rel = `${relative(e.project, outside)}/secret.txt`;
    const lines = ['link.txt:1:1: error: a', `${outside}/secret.txt:1:1: error: b`, `${rel}:1:1: error: c`];
    cli(e, ['run', '--', ...node(`for (const l of ${JSON.stringify(lines)}) console.log(l)`)]);
    const bin = join(e.state, 'editor');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    assert.match(rel, /^\.\.\//);
    for (const n of ['1', '2', '3']) {
      const r = cli(e, ['open', n], { env: { EDITOR: bin } });
      assert.equal(r.status, 1, `open ${n} should be refused`);
      assert.match(r.stderr, /outside the workspace/);
    }
    assert.equal(cli(e, ['open', '1', '--allow-outside'], { env: { EDITOR: bin } }).status, 0);
  });

  it('refuses a file swapped for a symlink out of the workspace after capture', () => {
    const outside = tempDir({ 'secret.txt': 'x\n' });
    const e = setup();
    cli(e, ['run', '--', ...node(`console.error(${JSON.stringify(TSC_ERR)})`)]);
    // Captured as a regular file inside the workspace, replaced before opening.
    rmSync(join(e.project, 'src/user.ts'));
    symlinkSync(join(outside, 'secret.txt'), join(e.project, 'src/user.ts'));
    const bin = join(e.state, 'editor');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    const r = cli(e, ['open', '1'], { env: { EDITOR: bin } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /outside the workspace/);
  });

  it('passes a file name with shell metacharacters to the editor as one exact argument', () => {
    const name = 'src/$(touch pwned); `id` & x.ts';
    const e = setup({ [name]: 'a\nb\n' });
    cli(e, ['run', '--', ...node(`console.log(${JSON.stringify(`${name}:2:1: error: bad`)})`)]);
    const log = join(e.state, 'args.log');
    const bin = join(e.state, 'editor');
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
    chmodSync(bin, 0o755);
    assert.equal(cli(e, ['open', '1'], { env: { EDITOR: bin } }).status, 0);
    assert.deepEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean), ['+2', join(e.project, name)]);
    assert.equal(existsSync(join(e.project, 'pwned')), false);
  });

  it('strips terminal escapes from messages before listing them', () => {
    const e = setup();
    cli(e, ['run', '--', ...node(`console.error("src/user.ts(4,10): error TS1: a\\x1b]0;owned\\x07b")`)]);
    const text = cli(e, ['list']).stdout;
    assert.equal(text.includes('\x1b'), false);
    assert.match(text, /ab/);
  });

  it('stores no raw output', () => {
    const e = setup();
    // Built at run time so the value appears only in the output, never in the stored command line.
    cli(e, ['run', '--', ...node('console.log("SECRET_TOKEN=" + ["abc", "123"].join(""))')]);
    const files = spawnSync('cat', [join(e.state, readdir(e.state).find((f) => f.endsWith('.json'))!)], { encoding: 'utf8' }).stdout;
    assert.equal(files.includes('abc123'), false);
  });
});

function readdir(dir: string): string[] {
  return spawnSync('ls', [dir], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
}
