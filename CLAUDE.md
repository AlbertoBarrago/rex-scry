# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`rex-scry`: a CLI that wraps a command (`rex-scry run -- <cmd>`), passes its output through untouched, parses compiler/linter/test diagnostics from a copy, and stores them per workspace. Consumers: the CLI (`list`, `next`/`prev`, `open`), a live Ink panel (`ui`, `src/ui/`), Rex Lua actions (`rex/rex-scry.lua`: command-palette picker, panel split) and a Neovim plugin (`nvim/`, own quickfix list). Ink and React are the only runtime dependencies and load only for `ui`. Same stack and conventions as rex-usage and rex-canvas.

## Commands

```sh
npm run dev -- list --json                 # run from source (tsx src/cli.ts)
npm run build                              # tsc to dist/ + chmod +x dist/cli.js
npm run typecheck
npm test                                   # tsx --test test/*.test.ts (node:test), about 5 s
npx tsx --test test/parsers.test.ts        # single file
npx tsx --test --test-name-pattern="pretty" test/*.test.ts   # single test
rex config check rex/rex-scry.lua          # validate the Rex action
```

Tests never touch real state: they set `REX_SCRY_STATE_DIR`, drop `rex-nvim` from `PATH`, and use stubs (`REX_SCRY_REX_NVIM`, `EDITOR`). `test/nvim.test.ts` needs nvim 0.10+ and skips otherwise. CLI tests spawn `node --import <resolved tsx> src/cli.ts`: `--import tsx` alone would resolve from the temp project's cwd and fail.

To check against real Rex without touching the user's config: open a test window (`rex window new DiagTest -c <dir> --focus=false --json`), drive it with `rex send`/`rex send-key`, read `rex capture` and `rex block call -b <block> program_status`. Try the Lua action with `rex do <copy of the lua> --action rex_scry_next -b <block>`, pointing the copy at a stub instead of rex-nvim. Close the windows you created, by id.

## Architecture

Read `docs/architecture.md` (decisions D1 to D12) and `docs/research.md` (what Rex supports, verified). Key points that span files:

- Pipeline: `run.ts` copies child bytes to the terminal and to `Ingestor` (`pipeline.ts`); each stream gets its own `LineSplitter` (`lines.ts`) and parser sessions. Regular parsers are offered each line in registry order, the first claim stops the round; `generic` (fallback) sees only unclaimed lines and requires the file to exist.
- `normalize.ts` resolves paths against cwd then workspace root and takes the physical path (Rex reports cwds with the typed case; rex-nvim compares physical paths). `id` is a fingerprint, so the same problem keeps its id across runs.
- `store.ts`: one JSON file per workspace (`workspace.ts`: enclosing Git checkout), mkdir lock + atomic rename. `finishRun` supersedes older finished runs with the same `commandKey`; a run missing at finish (cleared) discards its results; dead `running` runs read as `interrupted`.
- `list --json` (`format.ts`) is the contract for the Lua action, the nvim plugin and agents: bump `SCHEMA_VERSION` (`types.ts`) and both Lua checks on breaking changes.

## Rex constraints (verified, do not re-try)

- No per-command output or lifecycle API: `terminal.child_exited` is per block program; `format`/`capture` is screen scraping; `data.connect`'s `rex.data.terminal.v1` is undocumented. Hence the explicit wrapper.
- `rex.exec` runs without the user's shell profile: the Lua file prepends common bin dirs to `PATH`. `io.popen`/`os.execute` raise errors in Rex Lua.
- `rex.ui.pick` works in actions run from keys or `rex do`, not in `rex.on` handlers, `pcall` or `rex.invoke`.
- OSC 7501 goes on record id `rex-scry` (the root record belongs to the wrapped program), only when stdout is a TTY.

## Toolchain quirks

- The panel: `src/ui/model.ts` is pure and tested; components render only; side effects live in `src/ui/actions.ts`. `ui` is reached through a dynamic import in `cmdUi`: never import `src/ui/` from other modules, or Ink loads for every command. To check it for real, start it in a Rex test window (`rex window new UiTest ... -- /usr/bin/env REX_SCRY_STATE_DIR=<tmp> node dist/cli.js ui`), drive it with `rex send`/`rex send-key` and read `rex capture`. Don't press `y` there: it writes the user's clipboard.
- Ink 8: `useWindowSize()` for the terminal size; JSX needs `"jsx": "react-jsx"` (set).
- ESM only (`"type": "module"`, `NodeNext`): relative imports in `src/` use the `.js` extension.
- TypeScript 7: `"types": ["node"]` in `tsconfig.json`.

## Demo

Public demo material uses synthetic projects only, never real repositories or output. Re-record with `npm run build && vhs demo/demo.tape`: `demo/setup.sh` builds the project in `$TMPDIR` with a `--clean` nvim shim. The tape sets `VISUAL` as well as `EDITOR` (the user's `VISUAL` wins otherwise) and `REX_SCRY_REX_NVIM=` (empty), so the real rex-nvim never opens tabs in the user's Rex while recording. Check frames (`ffmpeg -ss T -frames:v 1`) before publishing.

## VCS

Plain `git`: one branch per task off `main`, never commit directly on `main`.
