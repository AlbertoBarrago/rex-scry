import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eslintParser } from '../src/parsers/eslint.js';
import { genericParser } from '../src/parsers/generic.js';
import { selectParsers } from '../src/parsers/index.js';
import { brief, fixture, parse, tempDir } from './helpers.js';

describe('tsc', () => {
  it('reads the plain format, chained messages and paths with spaces', () => {
    const got = parse(fixture('tsc-plain.txt')).map(brief);
    assert.equal(got.length, 5);
    assert.deepEqual(got[1], {
      source: 'tsc',
      severity: 'error',
      file: 'src/chain.ts',
      line: 4,
      column: 14,
      code: 'TS2322',
      message: [
        "Type '(x: { id: string; }) => void' is not assignable to type 'Fn'.",
        "Types of parameters 'x' and 'x' are incompatible.",
        "Type '{ id: number; }' is not assignable to type '{ id: string; }'.",
        "Types of property 'id' are incompatible.",
        "Type 'number' is not assignable to type 'string'.",
      ].join('\n'),
    });
    assert.deepEqual(got[2], {
      source: 'tsc',
      severity: 'error',
      file: 'src/user.ts',
      line: 4,
      column: 10,
      code: 'TS18048',
      message: "'user' is possibly 'undefined'.",
    });
    assert.equal(got[4]!.file, 'src/with space.ts');
  });

  it('lets the next tool have its lines after a pretty code frame', () => {
    const dir = tempDir({ 'main.c': '' });
    const text = ['src/a.ts:1:1 - error TS1: one', '', '1 const a = 1;', '  ~', 'main.c:3:7: error: two'].join('\n');
    const got = parse(text, { cwd: dir }).map((d) => [d.source, d.message]);
    assert.deepEqual(got, [['tsc', 'one'], ['generic', 'two']]);
  });

  it('reads the pretty (colored) format: chained messages kept, code frames and related info left out', () => {
    const got = parse(fixture('tsc-pretty.txt')).map(brief);
    const plain = parse(fixture('tsc-plain.txt')).map(brief);
    assert.deepEqual(got, plain);
    assert.deepEqual(
      got.slice(2).map((d) => [d.file, d.line, d.column, d.code, d.message]),
      [
        ['src/user.ts', 4, 10, 'TS18048', "'user' is possibly 'undefined'."],
        ['src/user.ts', 6, 7, 'TS2322', "Type 'string' is not assignable to type 'number'."],
        ['src/with space.ts', 1, 14, 'TS2322', "Type 'number' is not assignable to type 'string'."],
      ],
    );
  });
});

describe('eslint', () => {
  it('reads stylish output, with and without a rule id', () => {
    const got = parse(fixture('eslint-stylish.txt')).map(brief);
    assert.deepEqual(got, [
      {
        source: 'eslint',
        severity: 'error',
        file: '/work/app/src/config.ts',
        line: 3,
        column: 7,
        code: '@typescript-eslint/no-unused-vars',
        message: "'unused' is assigned a value but never used",
      },
      { source: 'eslint', severity: 'warning', file: '/work/app/src/config.ts', line: 12, column: 1, code: 'no-console', message: 'Unexpected console statement' },
      { source: 'eslint', severity: 'error', file: '/work/app/src/my file.ts', line: 1, column: 1, message: 'Parsing error: Unexpected token )' },
    ].map((d) => ({ ...d, file: d.file.replace('/work/', '') })));
  });

  it('reads compact output', () => {
    const got = parse(fixture('eslint-compact.txt')).map(brief);
    assert.equal(got.length, 2);
    assert.equal(got[1]!.severity, 'warning');
    assert.equal(got[1]!.code, 'no-console');
  });

  it('ignores indented rows without a file header', () => {
    assert.deepEqual(parse('  3:7  error  something  rule\n', { parsers: [eslintParser] }), []);
  });
});

describe('rust', () => {
  it('reads cargo build errors and skips summaries', () => {
    const got = parse(fixture('cargo-build.txt'), { cwd: '/work/fx' }).map(brief);
    assert.deepEqual(got, [
      { source: 'rust', severity: 'error', file: 'src/main.rs', line: 4, column: 20, code: 'E0425', message: 'cannot find value `y` in this scope' },
      { source: 'rust', severity: 'error', file: 'src/main.rs', line: 3, column: 18, code: 'E0308', message: 'mismatched types' },
    ]);
  });

  it('reads the older panic format with the right file and message', () => {
    const got = parse("thread 'main' panicked at 'boom', src/main.rs:2:5\n", { cwd: '/work/fx' }).map(brief);
    assert.deepEqual(got, [{ source: 'rust', severity: 'error', file: 'src/main.rs', line: 2, column: 5, message: 'panicked: boom' }]);
  });

  it('reads warnings and test panics', () => {
    const got = parse(fixture('cargo-test.txt'), { cwd: '/work/fx' }).map(brief);
    assert.deepEqual(got, [
      { source: 'rust', severity: 'warning', file: 'src/main.rs', line: 2, column: 9, message: 'unused variable: `unused`' },
      { source: 'rust', severity: 'error', file: 'src/main.rs', line: 9, column: 21, message: 'panicked: assertion `left == right` failed' },
    ]);
  });
});

describe('python', () => {
  it('reads pytest long tracebacks at the failing line', () => {
    const got = parse(fixture('pytest-long.txt'), { cwd: '/work/py' }).map(brief);
    assert.deepEqual(got, [
      { source: 'pytest', severity: 'error', file: 'tests/test_math.py', line: 5, code: 'AssertionError', message: 'assert 3 == 4\n+  where 3 = add(1, 2)' },
      { source: 'pytest', severity: 'error', file: 'src/mathlib.py', line: 3, code: 'ValueError', message: 'ValueError: bad x' },
    ]);
  });

  it('reads --tb=short failures and collection errors', () => {
    const got = parse(fixture('pytest-short.txt'), { cwd: '/work/py' }).map(brief);
    assert.deepEqual(got, [
      { source: 'pytest', severity: 'error', file: 'tests/test_math.py', line: 5, message: 'assert 3 == 4\n+  where 3 = add(1, 2)' },
      { source: 'pytest', severity: 'error', file: 'tests/test_broken.py', line: 1, message: "ModuleNotFoundError: No module named 'missing'" },
    ]);
  });

  it('reads --tb=line', () => {
    const got = parse(fixture('pytest-line.txt'), { cwd: '/work/py' }).map(brief);
    assert.deepEqual(got, [{ source: 'pytest', severity: 'error', file: 'tests/test_math.py', line: 5, message: 'assert 3 == 4' }]);
  });

  it('reads Python warnings as warnings, not test failures', () => {
    const text = ['=============================== warnings summary ===============================', 'tests/test_math.py::test_add', '  /work/py/src/mathlib.py:12: DeprecationWarning: use add2', '    warnings.warn("use add2", DeprecationWarning)'].join('\n');
    const got = parse(text, { cwd: '/work/py' }).map(brief);
    assert.deepEqual(got, [{ source: 'python', severity: 'warning', file: 'src/mathlib.py', line: 12, code: 'DeprecationWarning', message: 'DeprecationWarning: use add2' }]);
  });

  it('does not read log lines outside pytest output as failures', () => {
    assert.deepEqual(parse('script.py:12: started worker\nscript.py:13: AssertionError\n', { cwd: '/work/py' }), []);
  });

  it('reads a SyntaxError, which has no Traceback header', () => {
    const text = ['  File "/work/py/app.py", line 3', '    def f(:', '          ^', 'SyntaxError: invalid syntax'].join('\n');
    const got = parse(text, { cwd: '/work/py' }).map(brief);
    assert.deepEqual(got, [{ source: 'python', severity: 'error', file: 'app.py', line: 3, code: 'SyntaxError', message: 'SyntaxError: invalid syntax' }]);
  });

  it('reports a traceback at the innermost frame of the project, not inside installed packages', () => {
    const text = [
      'Traceback (most recent call last):',
      '  File "/work/py/app.py", line 9, in <module>',
      '    main()',
      '  File "/usr/lib/python3.12/site-packages/lib/core.py", line 40, in run',
      '    raise KeyError(k)',
      "KeyError: 'x'",
    ].join('\n');
    const got = parse(text, { cwd: '/work/py' }).map(brief);
    assert.deepEqual(got.map((d) => [d.file, d.line]), [['app.py', 9]]);
  });

  it('reads a plain traceback at its innermost frame', () => {
    const got = parse(fixture('python-traceback.txt'), { cwd: '/work/py' }).map(brief);
    assert.deepEqual(got, [{ source: 'python', severity: 'error', file: 'app.py', line: 2, code: 'ValueError', message: 'ValueError: bad input' }]);
  });
});

describe('generic', () => {
  it('reads go and gcc output for files that exist', () => {
    const dir = tempDir({ 'main.go': 'package main\n', 'main.c': 'int main;\n' });
    const go = parse(fixture('go-build.txt'), { cwd: dir }).map(brief);
    assert.deepEqual(go, [
      { source: 'generic', severity: 'error', file: 'main.go', line: 4, column: 2, message: 'declared and not used: x' },
      { source: 'generic', severity: 'error', file: 'main.go', line: 5, column: 2, message: 'undefined: fmt' },
      { source: 'generic', severity: 'error', file: 'main.go', line: 5, column: 14, message: 'undefined: y' },
    ]);
    const gcc = parse(fixture('gcc.txt'), { cwd: dir }).map(brief);
    assert.equal(gcc.length, 2);
    assert.equal(gcc[0]!.code, '-Wint-conversion');
    assert.equal(gcc[0]!.message, "incompatible pointer to integer conversion initializing 'int' with an expression of type 'char[2]'");
  });

  it('finds root-relative paths printed by a tool run from a subdirectory', () => {
    const root = tempDir({ 'src/top.c': '' , 'pkg/.keep': '' });
    const got = parse('src/top.c:1:1: error: x\n', { cwd: `${root}/pkg`, root }).map(brief);
    assert.deepEqual(got.map((d) => d.file), ['src/top.c']);
  });

  it('reads mypy and ruff style codes', () => {
    const dir = tempDir({ 'a.py': '' });
    const got = parse('a.py:3: error: Name "x" is not defined  [name-defined]\na.py:1:8: F401 [*] `os` imported but unused\n', { cwd: dir }).map(brief);
    assert.deepEqual(got, [
      { source: 'generic', severity: 'error', file: 'a.py', line: 3, code: 'name-defined', message: 'Name "x" is not defined' },
      { source: 'generic', severity: 'error', file: 'a.py', line: 1, column: 8, code: 'F401', message: '`os` imported but unused' },
    ]);
  });

  it('does not read timestamps, URLs or missing files as locations', () => {
    const dir = tempDir({ 'real.txt': '' });
    const text = ['12:30:01: server started', 'http://localhost:8080: ok', 'missing.ts:3:4: error: nope', 'Time: 10:20: done'].join('\n');
    assert.deepEqual(parse(text, { cwd: dir, parsers: [genericParser] }), []);
  });

  it('is skipped for lines a tool parser claimed', () => {
    const dir = tempDir({ 'src/main.rs': '' });
    const got = parse('error[E0308]: mismatched types\n --> src/main.rs:3:18\n', { cwd: dir });
    assert.equal(got.length, 1);
    assert.equal(got[0]!.source, 'rust');
  });
});

describe('parser registry', () => {
  it('rejects unknown parser ids', () => {
    assert.throws(() => selectParsers(['tsc', 'nope']), /unknown parser "nope"/);
  });
});
