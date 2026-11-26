# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The JSON output carries its own `schemaVersion`.

## [Unreleased]

## [0.1.0] - unreleased

### Added

- `rex-diagnostics run -- COMMAND`: runs a command with stdout, stderr, stdin, exit status and signals preserved, and captures its diagnostics.
- Parsers for TypeScript (`tsc`, plain and pretty), ESLint (stylish, compact, unix), Rust (cargo, rustc, test panics), pytest and Python tracebacks, and a generic `file:line[:col]: message` fallback.
- Workspace-scoped storage with run lifecycle (running, completed, interrupted, failed to start), supersession of earlier runs of the same command, deduplication, and retention limits.
- `list` (text, plain, JSON schema 1), `next`/`prev`, `open` (rex-nvim, else `$VISUAL`/`$EDITOR`), `clear`, `path`, `doctor`.
- Rex actions: diagnostics picker in the command palette, next/previous, copy, clear; progress reported with OSC 7501.
- Neovim plugin: `:RexDiagnostics` loads a quickfix list of its own, replaced in place and refreshed when a run finishes; `:RexDiagnosticsClear`.
- `run` accepts the command without `--`; `list` ends with where its diagnostics come from; `next`/`prev` continue past a fixed diagnostic; a clean rerun reports how many diagnostics it cleared.
- `rex-diagnostics ui`: a live, colored panel (Ink) that follows the workspace, with filters, grouping, open, copy and clear; `ctrl+b D` opens it beside the pane in Rex.
- Python warnings and `SyntaxError`; tracebacks point at the innermost frame of the project instead of installed packages.

### Fixed before release (from two independent reviews)

- A malformed `file://` path in the output crashed the wrapper mid-build; parsing is now isolated from the pass-through.
- `run -- build | head` exited 0 for a failed build; a closed pipe no longer decides the exit status.
- Overlapping runs of the same command could bring back fixed errors; a lock taken over from a stale owner could admit two writers.
- `open` through rex-nvim could be redirected by a file named `FILE:LINE:COL`; the Neovim quickfix could list files outside the workspace.
- pytest location lines were read outside pytest output; the older Rust panic format gave a wrong file name; a pretty tsc code frame could hide the next tool's diagnostic; overlong lines parsed differently depending on chunk boundaries.
