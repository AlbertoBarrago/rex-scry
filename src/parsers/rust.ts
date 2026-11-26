import type { RawDiagnostic } from '../types.js';
import type { Parser, ParserSession } from './types.js';

// rustc / cargo / clippy human output:
//   error[E0308]: mismatched types
//     --> src/main.rs:4:18
const HEADER = /^(error|warning)(?:\[([A-Za-z0-9_:]+)\])?: (.+)$/;
const ARROW = /^\s*--> (.+):(\d+):(\d+)$/;
// Panics in `cargo test` / `cargo run` (Rust 1.73+ puts the message on the next line):
//   thread 'tests::it_works' panicked at src/lib.rs:10:9:
//   assertion `left == right` failed
// Recent toolchains add the thread id: thread 'tests::it_works' (27337492) panicked at ...
const PANIC = /^thread '([^']*)'(?: \(\d+\))? panicked at (.+):(\d+):(\d+):?$/;
// Older format: thread 'main' panicked at 'boom', src/main.rs:2:5
const PANIC_OLD = /^thread '([^']*)'(?: \(\d+\))? panicked at '(.*)', (.+):(\d+):(\d+)$/;

// Cargo summaries that look like headers but have no location.
const SUMMARY = /^(?:could not compile|aborting due to|build failed|`[^`]+` \(.*\) generated \d+ warnings?)/;

/**
 * Rust compiler output through cargo build/check/clippy/test. A header waits
 * for its `-->` line (always the next line in rustc's output); headers that
 * never get one (summaries) emit nothing.
 */
export const rustParser: Parser = {
  id: 'rust',
  create(): ParserSession {
    let header: { severity: 'error' | 'warning'; code?: string; message: string; age: number } | undefined;
    let panic: RawDiagnostic | undefined;
    return {
      line(text) {
        if (panic) {
          const p = panic;
          panic = undefined;
          if (text.trim() !== '' && !text.startsWith('note:') && !text.startsWith('stack backtrace:')) {
            p.message = `panicked: ${text.trim()}`;
            return { claimed: true, diagnostics: [p] };
          }
          return { claimed: false, diagnostics: [p] };
        }
        const arrow = ARROW.exec(text);
        if (arrow && header) {
          const d: RawDiagnostic = {
            source: 'rust',
            severity: header.severity,
            message: header.message,
            file: arrow[1]!,
            line: Number(arrow[2]),
            column: Number(arrow[3]),
          };
          if (header.code) d.code = header.code;
          header = undefined;
          return { claimed: true, diagnostics: [d] };
        }
        const h = HEADER.exec(text);
        if (h) {
          header = SUMMARY.test(h[3]!)
            ? undefined
            : { severity: h[1] as 'error' | 'warning', message: h[3]!, age: 0, ...(h[2] ? { code: h[2] } : {}) };
          return { claimed: true };
        }
        // The older form first: the newer pattern would read "'boom', src/main.rs" as the file.
        const po = PANIC_OLD.exec(text);
        if (po) {
          return {
            claimed: true,
            diagnostics: [{ source: 'rust', severity: 'error', message: `panicked: ${po[2]}`, file: po[3]!, line: Number(po[4]), column: Number(po[5]) }],
          };
        }
        const pn = PANIC.exec(text);
        if (pn) {
          panic = { source: 'rust', severity: 'error', message: 'panicked', file: pn[2]!, line: Number(pn[3]), column: Number(pn[4]) };
          return { claimed: true };
        }
        if (header && ++header.age > 1) header = undefined;
        return { claimed: false };
      },
      end() {
        const p = panic;
        panic = undefined;
        return p ? [p] : [];
      },
    };
  },
};
