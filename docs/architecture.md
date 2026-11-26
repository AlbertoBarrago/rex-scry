# Architecture

## Shape

One short-lived process per command, no daemon. Every command (`run`, `list`, `next`, `open`, ...) reads or updates a JSON file per workspace under a lock, then exits.

```text
rex-diagnostics run -- <command>
   child stdout/stderr ──► passed through untouched to the terminal
            │ (copy)
            ▼
   LineSplitter (per stream: UTF-8 across chunks, ANSI and CR redraws removed)
            ▼
   Parser sessions (registry: tsc, eslint, rust, python, then generic fallback)
            ▼
   normalize (absolute physical paths, 1-based positions, fingerprint id)
            ▼
   dedupe + per-run cap ──► store: <state>/<workspaceId>.json
                                   │
          ┌────────────────────────┼─────────────────────────┐
          ▼                        ▼                         ▼
   CLI list/next/open     Rex action (rex.ui.pick)    nvim plugin (:RexDiagnostics)
          │                        │                         │
          └──── rex-nvim open FILE:LINE:COL ◄────────────────┘ (quickfix: own list)
```

## Modules

| File | Role | Pure |
| --- | --- | --- |
| `src/types.ts` | Diagnostic and Run schema, `SCHEMA_VERSION` | yes |
| `src/lines.ts` | Chunked byte stream to clean lines | yes |
| `src/parsers/*.ts` | One file per tool format; `index.ts` is the registry | yes (generic stats files) |
| `src/normalize.ts` | Paths, positions, ids | stats files |
| `src/pipeline.ts` | `Ingestor`: streams, parsers, normalization, dedupe, cap | yes |
| `src/store.ts` | Workspace state file, lock, lifecycle, retention | I/O |
| `src/workspace.ts` | Workspace root (enclosing Git checkout) and id | stats files |
| `src/run.ts` | The wrapper: spawn, pass-through, signals, OSC 7501 | I/O |
| `src/open.ts` | Path validation, rex-nvim / `$EDITOR` opening | I/O |
| `src/format.ts` | Text, plain and JSON output | yes |
| `src/cli.ts`, `src/doctor.ts` | Commands | I/O |
| `src/ui/model.ts` | Panel rows, grouping, filters, cursor, viewport | yes |
| `src/ui/*.tsx`, `src/ui/actions.ts` | Panel components (Ink) and its side effects | I/O |
| `rex/rex-diagnostics.lua` | Rex actions: picker, next/prev, copy, clear | |
| `nvim/` | Neovim plugin: quickfix list, auto-refresh | |

## Decisions

### D1. TypeScript on Node 22, the standard library for the core

Same stack as rex-usage and rex-canvas (ESM, TS 7, `node:test` through `tsx`), so the author's tooling, install flow (`npm link`) and conventions apply unchanged. The wrapper, parsers, store and every command except `ui` use only Node's standard library: `child_process`, `util.parseArgs`, `string_decoder`, `crypto`. The panel's Ink and React are the only runtime dependencies (D13).
Trade-off: Node starts in about 40 ms, slower than a Go or Rust binary, but negligible next to the builds it wraps, and nothing runs while idle.

### D2. Explicit wrapper for ingestion

See `docs/research.md`: Rex has no supported per-command output or lifecycle API. The wrapper sees the real streams, exit code and signals, and gives each execution an identity (`runId`).
Trade-offs: the user has to opt in per command (an alias or a package script helps), and the child writes into pipes rather than a terminal (D3).

### D3. Pipes, colors by environment

stdin is inherited (prompts work); stdout and stderr are pipes copied byte for byte to the wrapper's own, with backpressure. Colors are requested through the common environment variables only when the wrapper's stdout is a terminal, the user has not set them, and `NO_COLOR` is unset. A PTY would keep `isatty` true but needs a native dependency.

The command's outcome always decides the wrapper's: when the reader of our stdout or stderr goes away (`| head`), the wrapper stops writing to that stream but keeps draining, parsing and recording, then exits with the command's status. Before re-raising a fatal signal it waits for its own writes to reach the OS.

### D4. Parsers are stateful sessions, one per stream

A parser is `{ id, fallback?, create(ctx) => { line(text), end() } }`. Each stream gets fresh sessions, so interleaved stdout and stderr never mix multiline state. The pipeline offers each line to the regular parsers in order; the first that claims it stops the round. Fallback parsers (`generic`) only see unclaimed lines, so `file:line: message` never duplicates a tool-specific match. Adding a tool is a new file plus one entry in `src/parsers/index.ts`; the pipeline does not change.

Parsing is fenced off from the pass-through: if a parser or normalization ever throws on some output, parsing stops for that run with a one-line warning, and the command's output, exit status and recording carry on. Normalization rejects what it cannot trust instead of throwing: malformed `file://` URLs, paths that decode to control characters.

pytest location lines (`x.py:12: ...`) are read only inside pytest output (after a `===` banner or a `___` section), because outside it they are ordinary log lines.

The generic parser accepts a location only when the file exists as a regular file (looked up like normalization does: cwd, then workspace root; only hits are cached). That one check removes timestamps (`12:30:01: ...`), URLs and log prefixes, which a permissive regex would otherwise read as locations.

### D5. Ids are fingerprints

`id` is a hash of workspace, source, severity, file, line, column, code and message. The same problem printed twice in a run is stored once; the same problem in two runs has the same id, which keeps the `next`/`prev` cursor stable across rebuilds. `list` shows a problem reported by several live runs once, from the newest run.

The cursor stores the id and the position. When the diagnostic under it disappears (fixed), `next`/`prev` continue from its position in the sorted list. The cursor moves inside the same locked transaction that reads the list, so a rebuild committing in between cannot hand back a diagnostic that no longer exists. `open` takes an exact id first, then a short number (list position), then an id prefix of 4 or more characters.

### D6. Execution-scoped replacement

A run's `commandKey` is a hash of cwd + argv (or `--key`). Each run gets a sequence number under the store lock when it starts, which orders runs even when they start in the same millisecond. When a run finishes, older finished runs with the same key are removed: rebuilding replaces the previous build's diagnostics, while a lint run and a type-check run in the same workspace coexist. The old diagnostics stay visible while the new run is still going. An interrupted run also supersedes (its partial results are the newest truth). Two exceptions discard a run's results when it finishes: it was cleared while it ran, or a newer run of the same command already finished (an overlapping older build must not bring back errors the newer one fixed).

### D7. One JSON file per workspace, under a lock

`$REX_DIAGNOSTICS_STATE_DIR`, else `$XDG_STATE_HOME/rex-diagnostics`, else `~/.local/state/rex-diagnostics`. The directory must belong to the user and is made `0700`; files are `0600`, and every new file (lock owner, temporary state) is created with `O_EXCL`, so a planted symlink makes the write fail instead of being followed.

Writes take a `mkdir` lock that records its owner (pid, host), then rename a temporary file over the state. A lock is stale when its owner died on this host or it is older than 10 s; a waiter takes it over by renaming it to a name of its own first, so of two waiters only one can win (removing it directly would let both in). Waiters give up after 15 s. `clear --all-workspaces` deletes each file under its lock, so a run finishing at that moment cannot write it back. A run left `running` by a wrapper that died (SIGKILL, pane closed) is read as `interrupted` when its pid is gone.
Why not SQLite or a daemon: the data is small (bounded below), access is rare and short, and a file needs nothing installed or running.

### D8. Bounded memory and retention

| Limit | Value |
| --- | --- |
| Line length | 64 KiB (longer lines are cut) |
| Message | 4,000 characters |
| Diagnostics per run | 5,000 (excess counted in `dropped`) |
| Runs per workspace | 32 (oldest finished first) |
| Age of a finished run | 14 days |

Retention applies to reads too: an expired run is not listed even before the next write. Raw output is never stored: only parsed diagnostics and run metadata (argv, cwd, pane, times, exit status).

### D9. Opening goes through rex-nvim, else `$EDITOR`

`open` validates the path first (absolute, exists, regular file, inside the workspace after resolving symlinks, unless `--allow-outside`), then runs `rex-nvim open 'rex-nvim://open/<percent-encoded path>?line=N&column=M'` as an argument list. The `FILE:LINE:COL` form is avoided on purpose: rex-nvim prefers a file that exists under the literal name, so a file named `a.ts:4:10` would be opened instead of the validated `a.ts`. Without rex-nvim it runs `$VISUAL`/`$EDITOR` with a position argument it knows (`+call cursor(l,c)` for vi-family editors, `-g file:l:c` for VS Code-family, `+l` otherwise). Without either, it prints the location and exits 69.

### D10. The Rex panel is the command palette

`rex.ui.pick` gives a native, filterable, keyboard-first list in every connected Rex app, themed by the app. The Lua action never parses anything itself: it runs `rex-diagnostics list --json` with `rex.exec` and checks `schemaVersion`. Without rex-nvim it opens nvim in a split beside the focused pane, on the canonical path the CLI printed after validating it (not the stored name). The split's PATH is set with `/usr/bin/env` in its command, since only documented terminal options are used.

### D11. Neovim pulls, it is never pushed to

`:RexDiagnostics` runs `rex-diagnostics list --json` and owns one quickfix list, found again by id and replaced in place. A new list is appended at the end of the stack (`nr = "$"`), so lists after the current one survive; explicit loads make it the current list, background refreshes never change which list is current. Only diagnostics inside the workspace become items. Auto-refresh watches the state directory (`vim.uv.new_fs_event`, the directory is created by `rex-diagnostics path` first), refreshes only a list that already exists, reuses the directory and filters of the last explicit load, keeps the cursor on the same diagnostic, skips identical lists and drops responses older than the newest request. No new IPC: the CLI never connects to nvim.

### D12. Program status through OSC 7501

`run` reports on the record id `rex-diagnostics` (not the root record, which belongs to the wrapped program): `working` at start, then `error` when errors were found, `done` otherwise, `idle` when interrupted. Only when stdout is a terminal, so redirected output stays byte-identical.

### D13. A live panel beside the picker, with Ink

The command-palette picker (D10) is for a quick jump. A build session wants something that stays open: `rex-diagnostics ui` is a TUI that follows the workspace while you fix things. It is built with Ink and React, like rex-usage, so both panels share their look (palette, banner, single-line rows that truncate instead of wrapping, a viewport centered on the cursor) and their patterns.

- Ink and React are loaded by a dynamic import in `cmdUi` only: `run`, `list` and the others never load them, so the wrapper's start-up time does not change.
- `src/ui/model.ts` is pure (rows, grouping, filters, cursor anchored to the diagnostic id, viewport) and tested without a terminal; components only render; `src/ui/actions.ts` holds the side effects (open, copy, clear).
- Data comes from the same store functions as `list`; nothing is parsed again. The panel refreshes on `fs.watch` of the state directory, with a 5 s poll as a safety net.
- Opening uses rex-nvim only: an editor launched from inside the panel would fight Ink for the terminal.
- Trade-off: two runtime dependencies where there were none. Accepted because the panel is optional, isolated behind one import, and matches the author's existing Rex panels.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Nothing to show (`next` at the end, unknown id), refused path, runtime error |
| 64 | Usage error (sysexits `EX_USAGE`) |
| 69 | No program to open files with (`EX_UNAVAILABLE`) |
| 126, 127 | `run`: the command could not be executed / was not found |
| N, 128+S | `run`: the command's exit status, or death by signal S (re-raised) |

## Not in the MVP

MCP server, shell integration that wraps commands automatically, a PTY mode, remote-host awareness in the Lua action, JSON reporters (`tsc` has none; `eslint -f json`, `cargo --message-format=json` would change what the user sees).
