import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, tempDir } from './helpers.js';

const TSX = import.meta.resolve('tsx');
const CLI = join(ROOT, 'src', 'cli.ts');

function nvimVersion(): [number, number] | undefined {
  const r = spawnSync('nvim', ['--version'], { encoding: 'utf8' });
  const m = /NVIM v(\d+)\.(\d+)/.exec(r.stdout ?? '');
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}
const v = nvimVersion();
const skip = !v ? 'nvim not installed' : v[0] === 0 && v[1] < 10 ? `nvim ${v.join('.')} is older than 0.10` : false;

/** argv of a build that prints these tsc lines on stderr. */
function build(lines: string[]): string[] {
  return ['rex-diagnostics', 'run', '--key', 'build', '--', process.execPath, '-e', `for (const l of ${JSON.stringify(lines)}) console.error(l)`];
}

describe('neovim quickfix', { skip }, () => {
  it('loads its own list, keeps other lists and the position, and leaves out files outside the workspace', () => {
    const project = tempDir({ '.git/HEAD': '', 'src/a.ts': 'x\ny\n', 'src/b.ts': 'z\n', 'src/c.ts': 'w\n' });
    const outside = tempDir({ 'secret.ts': 's\n' });
    const bin = tempDir();
    // A `rex-diagnostics` on PATH that runs this checkout's source.
    writeFileSync(join(bin, 'rex-diagnostics'), `#!/bin/sh\nexec '${process.execPath}' --import '${TSX}' '${CLI}' "$@"\n`);
    chmodSync(join(bin, 'rex-diagnostics'), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REX_DIAGNOSTICS_STATE_DIR: tempDir() };

    const [cmd, ...args] = build([
      'src/a.ts(2,1): error TS1: first',
      'src/b.ts(1,1): warning TS2: second',
      `${outside}/secret.ts(1,1): error TS3: outside`,
    ]);
    const first = spawnSync(cmd!, args, { cwd: project, env });
    assert.equal(first.status, 0);
    const rebuild = build(['src/a.ts(2,1): error TS1: first', 'src/c.ts(1,1): error TS4: third', 'src/b.ts(1,1): warning TS2: second']);

    const script = join(bin, 'check.lua');
    writeFileSync(
      script,
      `
local rd = require("rex-diagnostics")
rd.setup({ auto_refresh = false, open = false })
local out = {}
-- Two unrelated lists; going back to the first must not cost us the second.
vim.fn.setqflist({}, " ", { title = "one", items = { { filename = "x", lnum = 7, text = "unrelated" } } })
vim.fn.setqflist({}, " ", { title = "two", items = { { filename = "y", lnum = 8, text = "unrelated" } } })
vim.cmd("silent colder")
rd.load({ wait = true, silent = true })
local id = rd.list_id()
out.current_is_ours = vim.fn.getqflist({ id = 0 }).id == id
out.first = vim.tbl_map(function(i)
  return { vim.api.nvim_buf_get_name(i.bufnr), i.lnum, i.col, i.type, i.text }
end, vim.fn.getqflist({ id = id, items = 0 }).items)
-- Stand on b (the warning), rebuild with a new error c, reload.
vim.cmd("cc 2")
vim.system(vim.json.decode(${JSON.stringify(JSON.stringify(rebuild))})):wait()
rd.load({ wait = true, silent = true })
out.same_id = rd.list_id() == id
local after = vim.fn.getqflist({ id = id, items = 0, idx = 0 })
out.count = #after.items
out.idx_text = after.items[after.idx].text
out.titles = {}
for nr = 1, vim.fn.getqflist({ nr = "$" }).nr do
  table.insert(out.titles, vim.fn.getqflist({ nr = nr, title = 0 }).title)
end
io.stdout:write(vim.json.encode(out))
`,
    );
    const r = spawnSync('nvim', ['--headless', '--clean', '--cmd', `set rtp^=${join(ROOT, 'nvim')}`, '-c', `luafile ${script}`, '-c', 'qa!'], {
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.first, [
      [join(project, 'src/a.ts'), 2, 1, 'E', 'first [tsc TS1]'],
      [join(project, 'src/b.ts'), 1, 1, 'W', 'second [tsc TS2]'],
    ]);
    assert.equal(out.current_is_ours, true);
    assert.equal(out.same_id, true);
    assert.equal(out.count, 3);
    assert.equal(out.idx_text, 'second [tsc TS2]');
    assert.deepEqual(out.titles, ['one', 'two', 'rex-diagnostics']);
  });
});
