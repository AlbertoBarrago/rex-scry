# Research

Findings that shaped rex-scry, checked on 2026-11-26 against Rex `0.1.0-snapshot.2588` (commit `ccf7e69`), its CLI help (`rex --help`, `rex api list`, `rex api describe`), the built-in agent guide (`rex skill show`) and the official documentation at <https://www.superlogical.com/rex/docs> (pages cited below). Rex is in beta: re-check these points when the platform moves.

## What Rex offers that matters here

### Terminal output: no supported per-command stream

- **Events** (<https://www.superlogical.com/rex/docs/reference/events>): `terminal.child_exited` fires when the *block's* program exits, which is usually the shell. The docs state it "doesn't fire for each command you run inside a shell". There is no command-started or command-finished event, and no event carrying output.
- **OSC 133** (prompt and command marks) is mentioned by the Program Status Protocol only as something terminals react to (dropping `working` records at a new prompt). No API exposes command boundaries or exit codes from it.
- **`com.superlogical.terminal.format`** (what `rex capture` uses) returns the rendered screen and scrollback as text, HTML or VT. Reading it is screen scraping: it sees wrapped lines, redraws and whatever else is on screen, has no notion of which command printed what, and the scrollback silently drops old lines (about 64 MiB per terminal).
- **`data.connect`** gives a ticket for a "data connection" that "streams a block's content as it changes, such as a terminal's output", with subprotocol `rex.data.terminal.v1`. The subprotocol itself is not documented in the public docs, and it is the renderer's feed for a whole block, not per command.

Conclusion: passive capture would mean scraping the screen or reverse-engineering an undocumented stream. Both are excluded by the project's rules. **Ingestion uses an explicit wrapper**, `rex-scry run -- <command>`, which sees the command's real byte streams, its exit status and its signals.

### What Rex does document and rex-scry uses

| Capability | Source | Used for |
| --- | --- | --- |
| `REX_BLOCK` environment variable in every pane | `rex skill show` | The `paneId` of a run |
| Program Status Protocol, OSC 7501 | <https://www.superlogical.com/rex/docs/build/program-status> | `run` reports `working`, then `error`/`done`/`idle` with "3 errors · 1 warning"; Rex shows it on tab headers and in the session picker |
| `com.superlogical.terminal.program_status` block method | `rex api list` | Verifying the OSC 7501 record from tests and by hand |
| `rex.action`, `rex.bind` | <https://www.superlogical.com/rex/docs/customize/actions> | The Rex plugin's actions and keys |
| `rex.ui.pick` (command palette list, up to 2,000 items, filterable) | <https://www.superlogical.com/rex/docs/customize/custom-ui> | The native diagnostics panel |
| `rex.exec(argv, opts)`: runs a program without a shell | <https://www.superlogical.com/rex/docs/reference/lua> | The Lua action calls the CLI (`io.popen`/`os.execute` raise errors in Rex Lua) |
| `pwd` block method (OSC 7 report) | `rex api list`, `rex block call -b … pwd` | Finding the focused pane's workspace from the Lua action |
| `rex.session.new_split` with a terminal layout | Lua reference, rex-usage | Fallback editor split when rex-nvim is absent |
| `rex config check FILE` | CLI help | Validating `rex/rex-scry.lua` |

Observed details:

- `pwd` answers `{"pwd":"file://host/Users/x/projects/foo", ...}`: a URL, percent-encoded, spelled as the shell reported it. On macOS that spelling can differ in case from the disk (`projects` vs `Projects`), so workspace ids are computed from `realpath` (physical, on-disk spelling).
- A `rex.action` runs `rex.exec` with Rex's own environment, which does not load `~/.zshrc`. The author's plugins prepend common bin directories (`~/.local/bin`, `~/.npm-global/bin`, Homebrew); rex-scry does the same.
- `rex.ui.pick` cannot run inside `rex.on` handlers, `pcall`, or actions invoked with `rex.invoke`. Actions bound to keys and run with `rex do` can use it.
- OSC 7501 rules that matter: each report replaces its record; `working` is dropped at the next shell prompt, `done`/`error` survive it; `msg` and `title` are base64, single-line, at most 2,048 decoded bytes; an `id` addresses a child record so the wrapped program's own root record is untouched.

## The author's existing Rex plugins

| Repo | Stack | Shape | Conventions taken |
| --- | --- | --- | --- |
| [rex-usage](https://github.com/AlbertoBarrago/rex-usage) | TypeScript, Node 22+, ESM, TS 7, Ink | TUI meant for a Rex pane, plus `rex/rex-usage.lua` action bound to `ctrl+b>u` | Layout (`src/`, `test/*.test.ts` with `node:test` via `tsx`, `rex/*.lua`), scripts (`build`, `typecheck`, `test`, `prepare`), MIT, `"types": ["node"]` |
| [rex-canvas](https://github.com/AlbertoBarrago/rex-canvas) | TypeScript, Node 22+, ESM, **no runtime dependencies** | CLI + `rex/rex-canvas.lua` (`ctrl+b>m`) | Zero runtime deps, `rex` called as a subprocess, install via clone + `npm link` |
| [rex-nvim](https://github.com/AlbertoBarrago/rex-nvim) | zsh + Lua nvim plugin | `rex-nvim open FILE[:LINE[:COL]]`, nvim registry in `~/.cache/rex-nvim/<pid>.reg` | Exit codes from sysexits (64 usage, 69 unavailable), physical paths everywhere, plain git |
| rex-sessions, rex-themes (local) | Python, shell | Session snapshots, themes | Not relevant to diagnostics |

Each repo has a `CLAUDE.md` with commands, architecture and verified Rex constraints, a README with install, usage and known limits, and uses plain git with one branch per task.

### How rex-nvim opens files (reused, not reimplemented)

`rex-nvim open FILE:LINE:COL` (`lib/open.zsh`):

1. A registered nvim whose working directory holds the file (deepest root, most recently focused): Rex focuses its pane, then rex-nvim calls `require("rex-nvim").open(path, line, col)` over RPC (`--remote-expr luaeval(...)`, 3 s timeout, which avoids `--remote`'s `:drop` problems).
2. Else a new nvim tab in the Rex session whose terminal cwd is the deepest ancestor of the file.
3. Else the `files` session.
Then the app is switched to that session (`session.select`, needs Remote Control).

`FILE:LINE:COL` parsing prefers a name that exists as given, so a path containing `:` still works. Lines and columns are one-based.

Decision: rex-scry calls `rex-nvim open "<abs path>:<line>:<col>"` as a subprocess (an argument list, no shell). It does not read rex-nvim's registry or talk to nvim's RPC socket itself: that would duplicate rex-nvim's routing and couple us to its private file format.

## Neovim side

- Quickfix lists live on a stack (10 lists). `setqflist({}, ' ', what)` creates a new list; `setqflist({}, 'r', {id = N, items = ...})` replaces the items of list `N` only; `getqflist({id = N, title = 0})` tells whether it still exists. This is how "replace our diagnostics without destroying unrelated quickfix data" is done.
- `vim.system` (Neovim 0.10+) runs the CLI without a shell; `vim.uv.new_fs_event` watches the state directory for auto-refresh.
- Quickfix `col` is a one-based **byte** index; tsc reports UTF-16 code units, rustc and ESLint characters. They agree on ASCII lines only (documented in the plugin and README).

## Existing tools that overlap

From [awesome-rex](https://github.com/beejmaxx/awesome-rex) (read 2026-11-26):

- **vim-dispatch-extras**: a Rex strategy for dispatch.vim that runs `:Make` in a Rex pane. Diagnostics then come from Vim's `errorformat`, inside Vim only.
- **rex-opener**, **rex-open**, **rex-fzf-url**, **Rex copy-mode**: pick paths or URLs out of pane scrollback. They scrape the screen and know nothing about severity, tools or runs.

None of them captures diagnostics per command run, keeps them per workspace, or offers machine-readable output for agents. Nothing in the list is a diagnostics store.

## Constraints and assumptions

1. **No passive capture.** Only commands started through `rex-scry run` are captured. Shell integration that wraps every command automatically was considered (a `preexec` hook) and rejected for the MVP: it changes every command's stdio from a terminal to a pipe, which alters many programs' behavior.
2. **Pipes, not a pseudo-terminal.** The wrapped command writes into pipes, so tools that check `isatty` change behavior (tsc switches to its plain format; progress bars disappear). Colors are kept by setting `FORCE_COLOR`, `CLICOLOR_FORCE`, `CARGO_TERM_COLOR` and `PY_COLORS` when the user has not set them and the wrapper's own stdout is a terminal (`--no-color` disables this). A PTY would need a native module (node-pty), against the minimal-dependency rule.
3. **Signals.** Keyboard SIGINT/SIGQUIT already reach the command (same foreground process group), so the wrapper waits instead of forwarding a second copy. SIGTERM and SIGHUP sent to the wrapper are forwarded. A command killed by a signal makes the wrapper re-raise the same signal, so the shell sees the same status.
4. **The panel is the command palette.** Rex has no API for custom panes with their own UI other than running a program in a terminal block. `rex.ui.pick` is native, keyboard-first, themed by the app, and filterable, so it is the panel. A TUI in a split would duplicate it.
5. **Clipboard** for "copy diagnostic" uses `pbcopy` on the machine running the Rex server (macOS). Rex documents no clipboard-write API for Lua.
6. **Remote hosts.** Diagnostics are stored on the machine where `run` executes. The Lua action reads them on the Rex server's machine; with `rex -S` remote hosts the two can differ. Not handled in the MVP.
