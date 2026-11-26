# Contributing

Issues and pull requests are welcome. Keep changes small and in scope: one topic per pull request.

## Setup

```sh
git clone https://github.com/AlbertoBarrago/rex-diagnostics.git
cd rex-diagnostics
npm install
npm run typecheck
npm test
```

Node.js 22+. Neovim 0.10+ is needed for the quickfix test (it is skipped otherwise). Nothing needs a running Rex: tests use temporary directories, an isolated state directory (`REX_DIAGNOSTICS_STATE_DIR`) and stubs for rex-nvim and editors.

```sh
npm run dev -- list --json                                # run from source
npx tsx --test test/parsers.test.ts                       # one file
npx tsx --test --test-name-pattern="pretty" test/*.test.ts  # one test
rex config check rex/rex-diagnostics.lua                  # validate the Rex action
```

## Adding a parser

1. Capture real output of the tool into `test/fixtures/<tool>-<case>.txt` (replace machine-specific paths, such as a temp directory, with `/work/...`). If you cannot run the tool, write the fixture from its documented format and say so in the pull request.
2. Add `src/parsers/<tool>.ts` exporting a `Parser` (see `src/parsers/types.ts`). A session gets one line at a time, already free of ANSI escapes, and returns `{ claimed, diagnostics }`. Claim the lines of your format, including continuation lines, so the generic fallback skips them. Emit what is pending in `end()`.
3. Register it in `src/parsers/index.ts`.
4. Add tests in `test/parsers.test.ts`, including chunked input if the format is multiline.

The ingestion pipeline (`src/pipeline.ts`) should not need changes. If it does, open an issue first.

## Rules

- No new runtime dependencies without a strong reason, discussed first. Ink and React are used by the panel only (`src/ui/`), loaded through a dynamic import; keep the rest of the code on Node's standard library.
- Terminal output is untrusted: never execute it, never build shell strings, validate paths before opening them.
- Keep `list --json` backward compatible; a breaking change bumps `SCHEMA_VERSION` in `src/types.ts` and the checks in `rex/` and `nvim/`.
- Comments explain why, in English, JSDoc in TypeScript.
- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Demo material uses synthetic projects only.
