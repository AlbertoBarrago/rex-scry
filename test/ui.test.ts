import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compareDiagnostics } from '../src/store.js';
import { plainLine } from '../src/ui/actions.js';
import { applyFilter, buildRows, countBySeverity, moveCursor, resolveCursor, viewportStart } from '../src/ui/model.js';
import { ROOT, parse, tempDir } from './helpers.js';

const TEXT = [
  'src/b.ts(3,1): warning TS6133: unused',
  'src/a.ts(9,2): error TS2322: second in a',
  'src/a.ts(1,1): error TS2322: first in a',
  'src/c.ts(1,1): warning TS6133: only warning',
].join('\n');
// In the store's order, as the panel receives them.
const diags = parse(TEXT, { cwd: '/w' }).sort(compareDiagnostics);

describe('panel model', () => {
  it('groups by file, files with errors first, numbering the diagnostics', () => {
    const rows = buildRows(diags, 'file');
    assert.deepEqual(
      rows.map((r) => (r.kind === 'group' ? `# ${r.label}` : `${r.number} ${r.diagnostic.message}`)),
      ['# src/a.ts', '1 first in a', '2 second in a', '# src/b.ts', '3 unused', '# src/c.ts', '4 only warning'],
    );
  });

  it('groups by source and lists flat without groups', () => {
    assert.deepEqual(buildRows(diags, 'source').filter((r) => r.kind === 'group').map((r) => r.key), ['group:tsc']);
    assert.equal(buildRows(diags, 'none').every((r) => r.kind === 'diag'), true);
  });

  it('filters and counts by severity', () => {
    assert.deepEqual(applyFilter(diags, 'warning').map((d) => d.message), ['unused', 'only warning']);
    assert.deepEqual(countBySeverity(diags), { error: 2, warning: 2, info: 0, hint: 0 });
  });

  it('keeps the cursor on diagnostics, skipping group headings and stopping at the ends', () => {
    const rows = buildRows(diags, 'file');
    const first = resolveCursor(rows, undefined)!;
    assert.equal(rows[first]!.kind, 'diag');
    let id = moveCursor(rows, undefined, 'down');
    id = moveCursor(rows, id, 'down');
    assert.equal(rows[resolveCursor(rows, id)!]!.kind === 'diag' && (rows[resolveCursor(rows, id)!] as { diagnostic: { message: string } }).diagnostic.message, 'unused');
    assert.equal(moveCursor(rows, moveCursor(rows, id, 'bottom'), 'down'), moveCursor(rows, id, 'bottom'));
    assert.equal(moveCursor(rows, id, 'top'), moveCursor(rows, undefined, 'up'));
  });

  it('falls back to the first diagnostic when the selected one is gone', () => {
    const rows = buildRows(diags, 'file');
    assert.equal(resolveCursor(rows, 'no-such-id'), resolveCursor(rows, undefined));
    assert.equal(resolveCursor([], 'x'), undefined);
  });

  it('scrolls to keep the cursor centered', () => {
    assert.equal(viewportStart(100, 10, 50), 45);
    assert.equal(viewportStart(100, 10, 2), 0);
    assert.equal(viewportStart(100, 10, 99), 90);
    assert.equal(viewportStart(5, 10, 3), 0);
  });

  it('copies a diagnostic as one plain line', () => {
    const d = diags.find((x) => x.message === 'first in a')!;
    assert.equal(plainLine({ ...d, message: 'line one\n  line two' }), `${d.file}:1:1: error: line one line two [TS2322]`);
  });
});

describe('ui command', () => {
  it('refuses to start without a terminal', () => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(ROOT, 'src', 'cli.ts'), 'ui'], {
      cwd: tempDir(),
      env: { ...process.env, REX_DIAGNOSTICS_STATE_DIR: tempDir() },
      encoding: 'utf8',
      input: '',
    });
    assert.equal(r.status, 64);
    assert.match(r.stderr, /needs a terminal/);
  });
});
