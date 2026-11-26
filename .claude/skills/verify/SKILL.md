---
name: verify
description: Verify a change to rex-diagnostics end to end before saying "ready for testing" or committing. Runs the cheap checks first, then drives the built CLI on a synthetic project and reports the evidence plus the Verified trailer value.
---

# Verify rex-diagnostics

Run the steps in order and stop at the first failure. Fix the code, not the check.

## Rules

- Never add retries, sleeps or skips, and never edit the existing tests, typecheck config or this skill to make a step pass.
- If a step still fails after three fix attempts, stop and report the failing output and what was tried.
- Clean up what you started (temp dirs, Rex test windows) even when a step fails.
- Never point the CLI at the user's real state: always export `REX_DIAGNOSTICS_STATE_DIR` to a temp dir.

## 1. Cheap checks

    npm run typecheck
    npm test
    npm run build
    rex config check rex/rex-diagnostics.lua   # skip if rex is not installed, and say so

## 2. Run it

Use the built CLI (`node dist/cli.js`) on a synthetic project in the scratchpad, with `REX_DIAGNOSTICS_STATE_DIR` set to a temp dir and `rex-nvim` replaced by a stub (`REX_DIAGNOSTICS_REX_NVIM=<script that logs its args>`).

Smoke flows (always):

1. Capture: in a temp project with `src/user.ts` (5 lines), run `node dist/cli.js run --key build -- node -e 'console.error("src/user.ts(4,10): error TS18048: x"); process.exit(2)'`. Expected: the line is printed on stderr, exit status 2, `list --json` shows one diagnostic with `line: 4`, `column: 10`, `relativeFile: "src/user.ts"`.
2. Rerun replaces: `node dist/cli.js run --key build -- node -e 'process.exit(0)'` (same key, the "fixed" build). Expected: exit 0, `list --json` has no diagnostics and one run.
3. Open: capture again, then `open 1` with the stub. Expected: the stub logs `open` and `<abs path>:4:10`.
4. Must fail: `node dist/cli.js run` with no command. Expected: exit 64 and a usage message.

Flows for the changed area: parsers (run a fixture through `run -- cat test/fixtures/<file>` and inspect `list`), Rex action (`rex do <copy> --action rex_diagnostics_next -b <test block>` in a Rex test window, see CLAUDE.md), nvim plugin (`test/nvim.test.ts`).

Out of scope: `rex-diagnostics open` with the real rex-nvim (opens tabs in the user's session) unless the user asked for it; modifying `~/.config/rex/init.lua`.

## 3. Report

Reply with:

- each command run with its exit code;
- the evidence for every flow (output excerpt);
- the `Verified:` trailer value: `verify` when steps 1 and 2 passed, `tests` when only step 1 ran, `none (<reason>)` otherwise.
