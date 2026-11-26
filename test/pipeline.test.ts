import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanLine, LineSplitter, MAX_LINE_BYTES } from '../src/lines.js';
import { MAX_DIAGNOSTICS_PER_RUN } from '../src/pipeline.js';
import { insideRoot, normalize, resolveFile } from '../src/normalize.js';
import { brief, fixture, parse, tempDir, workspace } from './helpers.js';

describe('line splitting', () => {
  it('strips colors, hyperlinks and carriage-return redraws', () => {
    assert.equal(cleanLine('\x1b[96msrc/a.ts\x1b[0m:\x1b[93m4\x1b[0m'), 'src/a.ts:4');
    assert.equal(cleanLine('\x1b]8;;file:///x\x1b\\link\x1b]8;;\x1b\\'), 'link');
    assert.equal(cleanLine('50%\r75%\r100% done\r'), '100% done');
  });

  it('keeps lines intact across any chunk boundary, multibyte characters included', () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    for (const b of Buffer.from('a ✖ b\r\nsecond\nlast-no-newline')) s.push(Buffer.from([b]));
    s.end();
    assert.deepEqual(lines, ['a ✖ b', 'second', 'last-no-newline']);
  });

  it('cuts an overlong line the same way whatever the chunk boundaries', () => {
    const text = `${'x'.repeat(MAX_LINE_BYTES + 100)}\nnext\n`;
    const run = (size: number): string[] => {
      const lines: string[] = [];
      const s = new LineSplitter((l) => lines.push(l));
      for (let i = 0; i < text.length; i += size) s.push(text.slice(i, i + size));
      s.end();
      return lines;
    };
    const whole = run(text.length);
    assert.deepEqual(whole.map((l) => l.length), [MAX_LINE_BYTES, 4]);
    for (const size of [1000, 4096, MAX_LINE_BYTES - 1, MAX_LINE_BYTES + 1]) assert.deepEqual(run(size), whole);
  });

  it('bounds a line that never ends', () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    s.push('x'.repeat(MAX_LINE_BYTES + 10));
    s.end();
    assert.equal(lines[0]!.length, MAX_LINE_BYTES);
  });
});

describe('pipeline', () => {
  it('gives the same diagnostics whatever the chunk size', () => {
    const whole = parse(fixture('tsc-pretty.txt'));
    for (const chunk of [1, 3, 7, 64]) assert.deepEqual(parse(fixture('tsc-pretty.txt'), { chunk }), whole);
    const cargo = parse(fixture('cargo-build.txt'), { cwd: '/work/fx' });
    assert.deepEqual(parse(fixture('cargo-build.txt'), { cwd: '/work/fx', chunk: 5 }), cargo);
  });

  it('deduplicates a diagnostic printed twice', () => {
    const line = "src/user.ts(4,10): error TS18048: 'user' is possibly 'undefined'.\n";
    assert.equal(parse(line + line + line).length, 1);
  });

  it('keeps stdout and stderr state apart when they interleave', async () => {
    const { Ingestor } = await import('../src/pipeline.js');
    const { PARSERS } = await import('../src/parsers/index.js');
    const ing = new Ingestor(PARSERS, { cwd: '/work', workspace: workspace('/work'), runId: 'r' });
    const out = ing.stream();
    const err = ing.stream();
    err.push('error[E0308]: mismatched types\n');
    out.push('   Compiling x v0.1.0\n');
    err.push(' --> src/main.rs:3:18\n');
    out.end();
    err.end();
    assert.deepEqual(ing.diagnostics.map(brief), [
      { source: 'rust', severity: 'error', file: 'src/main.rs', line: 3, column: 18, code: 'E0308', message: 'mismatched types' },
    ]);
  });

  it('rejects malformed file URLs instead of throwing', () => {
    assert.deepEqual(parse('error[E1]: x\n --> file:///tmp/%ZZ:3:1\n'), []);
    assert.deepEqual(parse('error[E1]: x\n --> file:///tmp/a%1Bb.rs:3:1\n'), []);
  });

  it('survives malformed and truncated output', () => {
    const junk = ['src/a.ts(x,1): error TS1: bad', 'error[E1]: no arrow follows', ' --> :0:0', '\x1b[31', 'thread \'t\' panicked at src/x.rs:1:1:'].join('\n');
    const got = parse(junk);
    // Only the panic, cut off by the end of output, is still reported.
    assert.deepEqual(got.map((d) => [d.source, d.line]), [['rust', 1]]);
  });

  it('caps the number of diagnostics per run', () => {
    let text = '';
    for (let i = 1; i <= MAX_DIAGNOSTICS_PER_RUN + 5; i++) text += `src/a.ts(${i},1): error TS1: e\n`;
    assert.equal(parse(text).length, MAX_DIAGNOSTICS_PER_RUN);
  });
});

describe('normalization', () => {
  it('resolves relative paths against cwd, then the workspace root', () => {
    const root = tempDir({ 'pkg/src/lib.rs': '', 'top.ts': '' });
    assert.equal(resolveFile('src/lib.rs', `${root}/pkg`, root), `${root}/pkg/src/lib.rs`);
    assert.equal(resolveFile('top.ts', `${root}/pkg`, root), `${root}/top.ts`);
    assert.equal(resolveFile('nope.ts', `${root}/pkg`, root), `${root}/pkg/nope.ts`);
    assert.equal(resolveFile(`file://${root}/top.ts`, '/', root), `${root}/top.ts`);
  });

  it('tells inside from outside the workspace', () => {
    assert.equal(insideRoot('/w/a/b.ts', '/w'), 'a/b.ts');
    assert.equal(insideRoot('/w2/b.ts', '/w'), undefined);
    assert.equal(insideRoot('/w/../etc/x', '/w'), undefined);
  });

  it('rejects positions that are not one-based and strips control characters', () => {
    const ctx = { cwd: '/w', workspace: workspace('/w'), runId: 'r', now: 1 };
    assert.equal(normalize({ source: 'x', severity: 'error', message: 'm', file: 'a', line: 0 }, ctx), undefined);
    const d = normalize({ source: 'X Tool!', severity: 'error', message: 'evil\x1b]0;title\x07 text', file: 'a', line: 2, column: 0 }, ctx)!;
    assert.equal(d.column, undefined);
    assert.equal(d.source, 'xtool');
    assert.equal(d.message.includes('\x1b'), false);
  });

  it('gives the same id to the same problem in different runs', () => {
    const a = parse("src/a.ts(1,1): error TS1: e\n", { runId: 'run_1' });
    const b = parse("src/a.ts(1,1): error TS1: e\n", { runId: 'run_2' });
    assert.equal(a[0]!.id, b[0]!.id);
    assert.notEqual(a[0]!.runId, b[0]!.runId);
  });
});
