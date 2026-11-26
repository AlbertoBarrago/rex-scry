import type { RawDiagnostic, Severity } from '../types.js';
import { appendLine, type Parser, type ParserSession } from './types.js';

// `tsc --pretty false`, and tsc whenever its output is not a terminal:
//   src/user.ts(42,13): error TS18048: 'user' is possibly 'undefined'.
const PLAIN = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;
// `tsc --pretty` (the default on a terminal):
//   src/user.ts:42:13 - error TS18048: 'user' is possibly 'undefined'.
const PRETTY = /^(.+?):(\d+):(\d+) - (error|warning|message) (TS\d+): (.*)$/;
// Chained message lines (plain format only) are indented under the header.
const CONTINUATION = /^ {2,}(\S.*)$/;

function severity(word: string): Severity {
  if (word === 'warning') return 'warning';
  if (word === 'message') return 'info';
  return 'error';
}

// Pretty-mode lines after a header: blank, a code line ("42 ..."), or indented (underline, related info).
const FRAME = /^(?:$|\d+ |\s)/;
// Pretty-mode lines that end a diagnostic's block.
const SUMMARY = /^(Found \d+ errors?|Errors {2}Files|Watching for file changes)/;

/**
 * TypeScript compiler (tsc, vue-tsc, tsc -b). Both formats put chained
 * message lines right under the header; the pretty format then adds a blank
 * line and a code frame, which is claimed but not added to the message.
 */
export const tscParser: Parser = {
  id: 'tsc',
  create(): ParserSession {
    let open: RawDiagnostic | undefined;
    let pretty = false;
    let inFrame = false;
    const flush = (): RawDiagnostic[] => {
      const done = open ? [open] : [];
      open = undefined;
      return done;
    };
    return {
      line(text) {
        const plain = PLAIN.exec(text);
        const m = plain ?? PRETTY.exec(text);
        if (m) {
          const emitted = flush();
          pretty = plain === null;
          inFrame = false;
          open = {
            source: 'tsc',
            file: m[1]!,
            line: Number(m[2]),
            column: Number(m[3]),
            severity: severity(m[4]!),
            code: m[5]!,
            message: m[6]!,
          };
          return { claimed: true, diagnostics: emitted };
        }
        if (open) {
          const c = CONTINUATION.exec(text);
          if (c && !inFrame) {
            open.message = appendLine(open.message, c[1]!);
            return { claimed: true };
          }
          if (pretty && !SUMMARY.test(text.trim()) && FRAME.test(text)) {
            // The blank line, code frame lines ("42   const x = user.name", "     ~~~~")
            // and indented related information. Anything else belongs to another tool.
            inFrame = true;
            return { claimed: true };
          }
        }
        return { claimed: false, diagnostics: flush() };
      },
      end: flush,
    };
  },
};
