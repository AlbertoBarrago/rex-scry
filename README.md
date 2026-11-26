# rex-diagnostics

**Every terminal error, one jump away.**

<p align="center">
  <img src="demo/rex-diagnostics.gif" width="900" alt="rex-diagnostics demo: tsc runs through the wrapper, list shows three errors, open jumps to user.ts line 8 column 10 in Neovim, :RexDiagnostics fills the quickfix list, and after a fix the rebuild replaces the old errors">
  <br>
  <sub><a href="demo/rex-diagnostics.mp4">Full-resolution video (MP4)</a></sub>
</p>

Compiler errors, test failures and lint warnings scroll past in terminal panes and are gone. To fix them you scroll back, read a path, and type it into your editor. rex-diagnostics reads them from the command's output as it runs, records them per workspace when it ends, and lets you list, filter and export them, or jump straight to the line in Neovim, from the shell, from the [Rex](https://www.superlogical.com/rex) command palette, or from nvim's quickfix list.

```console
$ rex-diagnostics run -- npx tsc -p .
src/user.ts(42,13): error TS18048: 'user' is possibly 'undefined'.
src/api.ts(18,5): error TS2339: Property 'id' does not exist on type 'Session'.
rex-diagnostics: 2 errors (rex-diagnostics list)

$ rex-diagnostics list
DIAGNOSTICS  2 errors

src/api.ts
  1  ERROR    src/api.ts:18:5  TS2339 tsc
              Property 'id' does not exist on type 'Session'.

src/user.ts
  2  ERROR    src/user.ts:42:13  TS18048 tsc
              'user' is possibly 'undefined'.

$ rex-diagnostics open 2        # nvim in Rex, cursor on 42:13
```

Fix, run the same command again, and the old diagnostics are replaced, not piled up.

It runs locally, sends nothing anywhere, never edits your files, and stores only the parsed diagnostics (never raw output). Its only runtime dependencies are Ink and React, loaded just for the live panel.

## Install

Requires **Node.js 22+**. Rex, [rex-nvim](https://github.com/AlbertoBarrago/rex-nvim) and Neovim 0.10+ are optional.

```sh
npm install -g github:AlbertoBarrago/rex-diagnostics   # builds on install
rex-diagnostics doctor
```

Or from a clone, which the Rex action and Neovim plugin below can point at:

```sh
git clone https://github.com/AlbertoBarrago/rex-diagnostics.git ~/Projects/rex-diagnostics
cd ~/Projects/rex-diagnostics
npm install          # also builds dist/ through the prepare script
npm link             # or: ln -s "$PWD/dist/cli.js" ~/.local/bin/rex-diagnostics
rex-diagnostics doctor
```

### Rex action (optional)

```sh
cp rex/rex-diagnostics.lua ~/.config/rex/
echo 'require("rex-diagnostics")' >> ~/.config/rex/init.lua
rex config check && rex config reload
```

| Key | Action | Does |
| --- | --- | --- |
| `ctrl+b d` | `rex_diagnostics` | Pick a diagnostic of the focused pane's workspace in the command palette, open it |
| `ctrl+b j` / `ctrl+b k` | `rex_diagnostics_next` / `_prev` | Open the next / previous one |
| `ctrl+b D` | `rex_diagnostics_panel` | Open the live panel (`rex-diagnostics ui`) in a split beside the pane |
| palette | "Diagnostics: Copy…" | Copy one as `file:line:col: severity: message` (`pbcopy`) |
| palette | "Diagnostics: Clear" | Clear the workspace's diagnostics |

`rex do rex_diagnostics severity=error` shows errors only. The workspace comes from the directory the focused terminal reports (OSC 7, which zsh, fish and most prompts send). Opening goes through rex-nvim; without it, nvim opens in a split beside the pane.

Rex runs actions without your shell profile. The action looks for `rex-diagnostics` and `node` in `~/.local/bin`, `~/.npm-global/bin`, Homebrew, and the shims of volta, mise, asdf and fnm. With nvm, set `REX_DIAGNOSTICS_BIN` at the top of the `.lua` file to the absolute path of `rex-diagnostics` (`which rex-diagnostics`), or add nvm's bin directory to `EXTRA_PATH`.

### Neovim plugin (optional)

With lazy.nvim (point `dir` at your clone, or at `$(npm root -g)/rex-diagnostics/nvim` for a global install):

```lua
local dir = vim.fn.expand("~/Projects/rex-diagnostics/nvim")
return {
  { dir = dir, name = "rex-diagnostics", lazy = false, cond = vim.uv.fs_stat(dir) ~= nil },
}
```

Without a plugin manager: `vim.opt.rtp:append(vim.fn.expand("~/Projects/rex-diagnostics/nvim"))`.

- `:RexDiagnostics [filters]` loads the workspace's diagnostics into a quickfix list of their own and opens the window; then `:cnext`, `:cprev`, `:cc N` as usual. Filters are CLI flags: `:RexDiagnostics --severity error`.
- The list refreshes by itself when a run in the workspace finishes, with the same directory and filters, keeping the cursor on the same diagnostic. It is replaced in place: other quickfix lists (`:make`, `:grep`, LSP) and their history are untouched.
- Only files inside the workspace become quickfix entries; the message says how many were left out.
- `:RexDiagnosticsClear` empties it and clears the stored diagnostics.
- `require("rex-diagnostics").setup({ auto_refresh = true, open = true, cmd = { "rex-diagnostics" } })`.

### Uninstall

```sh
rex-diagnostics clear --all-workspaces # first: removes stored diagnostics
npm uninstall -g rex-diagnostics       # or npm unlink -g, or remove the ~/.local/bin symlink
rm ~/.config/rex/rex-diagnostics.lua   # and the require line in ~/.config/rex/init.lua
rm -rf ~/.local/state/rex-diagnostics  # or $XDG_STATE_HOME/rex-diagnostics
```

Remove the nvim spec or `rtp` line if you added one.

## Usage

```sh
rex-diagnostics run [--key K] [--parser LIST] [--no-status] [--no-color] [-q] [--] COMMAND [ARGS...]
rex-diagnostics list [--severity LIST] [--source LIST] [--file TEXT] [--group file|source|none]
rex-diagnostics list --json | --format plain
rex-diagnostics next | prev [filters] [--open] [--json]
rex-diagnostics open N|ID [filters] [--print] [--no-editor] [--allow-outside]
rex-diagnostics clear [--run ID | --all-workspaces]
rex-diagnostics ui [--severity error|warning]   # live panel
rex-diagnostics path        # this workspace's state file
rex-diagnostics doctor
```

Every command takes `-C DIR` to act for another directory's workspace.

- **`run`** passes the command's stdout and stderr through byte for byte, inherits stdin, and exits with the command's status (or dies from the same signal), even when you pipe it into `head`. `--` is optional when the command does not start with `-`. `--key` groups runs: a finished run replaces the diagnostics of earlier runs with the same key (default: same directory and same command line); a rerun that comes back clean says how many it cleared. `--parser tsc,eslint` limits parsing to those parsers.
- **`list`** numbers the entries and ends with where they come from (a run in progress, the last run, its exit status); files that no longer exist are marked. `open N` uses that number with the same filters, or a diagnostic id (or a unique prefix of 4 or more characters).
- **`next` / `prev`** move a cursor stored per workspace and stop at the ends (exit 1), like `:cnext`. When the diagnostic under the cursor gets fixed, they continue from where it was.
- **`open`** checks the path (it must exist and lie inside the workspace, after resolving symlinks), then hands it to rex-nvim as a `rex-nvim://open/...?line=&column=` link, else to `$VISUAL`/`$EDITOR`. With neither, it prints the location and exits 69. `--no-editor` skips `$EDITOR` (for callers without a terminal). `REX_DIAGNOSTICS_REX_NVIM` names the rex-nvim binary; set it to an empty value to never use rex-nvim.

The **workspace** is the enclosing Git checkout of the directory, else the directory itself. Diagnostics from different workspaces never mix; each one keeps the run (id, command, cwd, Rex pane) it came from.

Tip: make the wrapper the default for a project's scripts, e.g. `"typecheck": "rex-diagnostics run -- tsc -p ."` in `package.json`, or an alias such as `alias rd='rex-diagnostics run --'`.

### Live panel

`rex-diagnostics ui` (or `ctrl+b D` in Rex) opens a panel that follows the workspace: it refreshes the moment a run finishes, shows the run in progress or the last one, and keeps the cursor on the same diagnostic across rebuilds. It runs in the alternate screen, so quitting gives your scrollback back.

| Key | Does |
| --- | --- |
| `j` / `k`, `↓` / `↑` | move |
| `g` / `G`, `ctrl+d` / `ctrl+u` | first / last, half page down / up |
| `enter`, `o`, `l` | open in Neovim through rex-nvim |
| `e` / `w` / `a`, `f` | errors only / warnings only / all, cycle |
| `tab` | group by file, by tool, or not at all |
| `y` | copy the diagnostic as `file:line:col: severity: message` |
| `c` `c` | clear the workspace's diagnostics (press twice) |
| `r` / `q` | refresh / quit |

Opening from the panel goes through rex-nvim only (an editor started there would fight the panel for the terminal); without it the status line shows the location. `--severity error` starts filtered.

### In Rex

While a wrapped command runs, its tab shows Rex's working spinner; when it ends, the tab and the session picker show the result ("3 errors · 1 warning"). This uses Rex's documented [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status) (OSC 7501), only when stdout is a terminal; `--no-status` turns it off.

### For scripts and agents

`rex-diagnostics list --json` is the stable contract (no decorative text, same state gives the same bytes):

```json
{
  "schemaVersion": 1,
  "workspace": { "workspaceId": "ws_0123456789abcdef", "root": "/Users/me/app" },
  "counts": { "error": 1, "warning": 0, "info": 0, "hint": 0 },
  "runs": [
    { "runId": "run_m3x9k2_1a2b3c4d", "commandKey": "…", "command": ["npx", "tsc", "-p", "."], "cwd": "/Users/me/app",
      "paneId": "block:…", "startedAt": 1764170000000, "endedAt": 1764170004000, "status": "completed",
      "exitCode": 2, "dropped": 0, "diagnosticCount": 1 }
  ],
  "diagnostics": [
    { "id": "9f2c41d07b6e3a15", "workspaceId": "ws_0123456789abcdef", "runId": "run_m3x9k2_1a2b3c4d", "paneId": "block:…",
      "source": "tsc", "severity": "error", "message": "'user' is possibly 'undefined'.",
      "file": "/Users/me/app/src/user.ts", "relativeFile": "src/user.ts", "line": 42, "column": 13,
      "code": "TS18048", "timestamp": 1764170003000 }
  ]
}
```

Lines and columns are one-based. `file` is absolute; `relativeFile` is present when the file is inside the workspace. `severity` is `error`, `warning`, `info` or `hint`; run `status` is `running`, `completed`, `interrupted` or `failed_to_start`. `--format plain` prints `FILE:LINE:COL: SEVERITY: MESSAGE [CODE]`, one per line, which Vim's default `errorformat` reads.

Claude Code, Codex or any agent can read this without an integration: "run `rex-diagnostics list --json` and fix the errors".

## Supported tools

| Tool | Parser | Formats |
| --- | --- | --- |
| TypeScript (`tsc`, `tsc -b`, `vue-tsc`) | `tsc` | plain and `--pretty`, chained messages |
| ESLint | `eslint` | stylish (default), compact, unix |
| Rust (`cargo build/check/clippy/test`, `rustc`) | `rust` | errors and warnings with codes, test panics |
| pytest | `python` | `--tb=auto/long/short/line`, collection errors |
| Python | `python` | tracebacks (at the innermost frame in your code, not in installed packages), `SyntaxError`, warnings |
| Anything printing `file:line[:col]: message` | `generic` | gcc/clang, Go, mypy, ruff (concise), shellcheck (gcc), … |

The generic parser only accepts paths that exist, and only on lines no other parser claimed. Fixtures in `test/fixtures/` are real output from tsc 7, cargo 1.9x, go and clang, except pytest and ESLint, which were written from their documented formats.

## Status

**Implemented (0.1.0, hardened after two independent reviews):** the `run` wrapper (pass-through, exit codes, signals, colors), the parsers above, workspace-scoped storage with run lifecycle, supersession, deduplication and retention limits, `list` (text, plain, JSON), `next`/`prev`, `open` (rex-nvim, `$EDITOR`), `clear`, `doctor`, the live panel (`ui`), the Rex actions (picker, panel, next/prev, copy, clear) and OSC 7501 status, the Neovim quickfix plugin with auto-refresh.

**Planned:** a PTY mode so wrapped tools still see a terminal, optional shell integration, more parsers (Go test, Jest/Vitest, Swift), Linux clipboard support in the Rex action, an MCP server.

**Not planned:** fixing code, AI features, language servers, cloud sync, recording terminal sessions.

## Known limits

- Only commands started through `rex-diagnostics run` are captured: Rex has no supported way to read a command's output passively (see [docs/research.md](docs/research.md)).
- The command writes into pipes, not a terminal, so tools that check for one may print differently (progress bars disappear; tsc picks its plain or pretty format depending on its version and the color variables, and both are parsed). Colors are kept through `FORCE_COLOR`, `CLICOLOR_FORCE`, `CARGO_TERM_COLOR` and `PY_COLORS` (only those you have not set yourself).
- `kill -INT` sent to the wrapper alone is not forwarded (Ctrl-C reaches the command directly); use `kill -TERM`. A command killed by a signal Node cannot raise on itself (`SIGPIPE`) ends the wrapper with status 128+N instead.
- Diagnostics are recorded when the command ends. Watch modes (`tsc --watch`, `vitest`, `cargo watch`) never end, so their diagnostics are not recorded; `list` shows the run as in progress.
- Paths are resolved against the command's directory, then the workspace root. Monorepo runners that run each package in its own directory (`pnpm -r`, `turbo`, `npm -w`) or prefix every line with the package name can produce paths that resolve nowhere (`list` marks them) or lines no parser recognizes. Run the package's command from its directory, or pass `-C`.
- Background processes the command leaves behind that keep its output open keep the wrapper waiting until they exit.
- Columns are what the tool reports (characters, UTF-16 units for tsc). Neovim's quickfix counts bytes, so on lines with non-ASCII text before the error the cursor can land a little early.
- The command line of each run is stored with its diagnostics. Avoid passing secrets as arguments to wrapped commands.
- The Rex action reads diagnostics on the machine running the Rex server; runs on remote hosts (`rex -S`) are not visible to it.

## Security

Terminal output is treated as untrusted input:

- Nothing parsed from it is ever executed. Every program (the command, rex-nvim, `$EDITOR`, nvim from the Rex action and the Neovim plugin) is started with an argument list, never a shell string.
- `open` accepts only an existing regular file inside the workspace after resolving symlinks, and passes rex-nvim a `rex-nvim://` link so no other file can be substituted by its name. The Neovim plugin puts only files inside the workspace into quickfix. A file swapped between the check and the editor opening it is outside what any of these can guard.
- Diagnostics are printed with control characters removed (`list`, `next`, errors). The command's own output is passed through as is: that is the point of the wrapper.
- State lives in a private directory (`0700`, files `0600`), written atomically under a lock. There is no network code and no telemetry.

## Docs

- [docs/research.md](docs/research.md): what Rex supports and how that shaped the design
- [docs/architecture.md](docs/architecture.md): modules, decisions and trade-offs
- [CONTRIBUTING.md](CONTRIBUTING.md): development, adding a parser
- [CHANGELOG.md](CHANGELOG.md)

## License

MIT
