import type { RawDiagnostic, Severity } from '../types.js';
import type { Parser, ParserSession } from './types.js';

// Stylish (the default formatter): a file header line, then one row per problem.
//   /repo/src/config.ts
//     12:1  warning  'x' is assigned a value but never used  no-unused-vars
const STYLISH_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/;
// The header is a path on its own line, not indented.
const STYLISH_HEADER = /^(\/\S.*|[A-Za-z]:\\.*|\.{0,2}\/?[\w.@-][^\s:]*\.[A-Za-z0-9]+)$/;
// Compact: /repo/src/a.ts: line 3, col 7, Error - Unexpected any. (@typescript-eslint/no-explicit-any)
const COMPACT = /^(.+): line (\d+), col (\d+), (Error|Warning) - (.*?)(?: \(([^()]+)\))?$/;
// Unix: /repo/src/a.ts:3:7: Unexpected any. [Error/@typescript-eslint/no-explicit-any]
const UNIX = /^(.+?):(\d+):(\d+): (.*) \[(Error|Warning)(?:\/([^\]]+))?\]$/;

const sev = (word: string): Severity => (word.toLowerCase() === 'warning' ? 'warning' : 'error');

/** ESLint: stylish, compact and unix formatters. */
export const eslintParser: Parser = {
  id: 'eslint',
  create(): ParserSession {
    // Header seen, but not yet confirmed by a row below it.
    let candidate: string | undefined;
    let file: string | undefined;
    return {
      line(text) {
        const compact = COMPACT.exec(text);
        if (compact) {
          const d: RawDiagnostic = {
            source: 'eslint',
            file: compact[1]!,
            line: Number(compact[2]),
            column: Number(compact[3]),
            severity: sev(compact[4]!),
            message: compact[5]!,
          };
          if (compact[6]) d.code = compact[6];
          return { claimed: true, diagnostics: [d] };
        }
        const unix = UNIX.exec(text);
        if (unix) {
          const d: RawDiagnostic = {
            source: 'eslint',
            file: unix[1]!,
            line: Number(unix[2]),
            column: Number(unix[3]),
            severity: sev(unix[5]!),
            message: unix[4]!,
          };
          if (unix[6]) d.code = unix[6];
          return { claimed: true, diagnostics: [d] };
        }
        const current = file ?? candidate;
        const row = current ? STYLISH_ROW.exec(text) : null;
        if (row && current) {
          file = current;
          candidate = undefined;
          const d: RawDiagnostic = {
            source: 'eslint',
            file,
            line: Number(row[1]),
            column: Number(row[2]),
            severity: sev(row[3]!),
            message: row[4]!.trim(),
          };
          if (row[5]) d.code = row[5];
          return { claimed: true, diagnostics: [d] };
        }
        if (text.trim() === '') {
          file = undefined;
          candidate = undefined;
          return { claimed: false };
        }
        if (STYLISH_HEADER.test(text)) {
          file = undefined;
          candidate = text;
          // Not claimed yet: until a row confirms it, the line may belong to another tool.
          return { claimed: false };
        }
        file = undefined;
        candidate = undefined;
        return { claimed: false };
      },
      end: () => [],
    };
  },
};
