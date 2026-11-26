import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { RawDiagnostic, Severity } from '../types.js';
import type { Parser, ParserSession } from './types.js';

// FILE:LINE[:COL]: [SEVERITY[\[CODE\]]:] MESSAGE
// Covers gcc/clang, go, mypy, ruff (concise), shellcheck (gcc format), and most Unix tools.
const LOCATION = /^([^\s:][^:]*?):(\d+)(?::(\d+))?:\s*(?:(fatal error|error|warning|warn|note|info|hint)(?:\[([^\]]+)\])?:\s*)?(.+)$/i;
// mypy appends its code after two spaces: "... has no attribute "x"  [attr-defined]",
// gcc/clang their warning flag after one: "... type 'char[2]' [-Wint-conversion]".
const TRAILING_CODE = /(?:\s{2}\[([\w-]+)\]|\s\[(-W[\w=-]+)\])$/;
// ruff and flake8 lead with theirs: "F401 [*] `os` imported but unused"
const LEADING_CODE = /^([A-Z]{1,4}\d{2,5})\s+(?:\[\*\]\s+)?(.*)$/;

function severity(word: string | undefined): Severity {
  switch (word?.toLowerCase()) {
    case 'warning':
    case 'warn':
      return 'warning';
    case 'note':
    case 'info':
      return 'info';
    case 'hint':
      return 'hint';
    default:
      // Tools that print a bare location (go, ruff) only print problems.
      return 'error';
  }
}

/**
 * The catch-all `file:line[:col]: message` format. It only sees lines no
 * tool-specific parser claimed, and only accepts a path that exists as a
 * regular file: timestamps ("12:30:01: ..."), URLs and log prefixes would
 * otherwise read as locations.
 */
export const genericParser: Parser = {
  id: 'generic',
  fallback: true,
  create(ctx): ParserSession {
    // Only hits are cached: a file the build generates later in the run must still be found.
    const found = new Set<string>();
    const regular = (path: string): boolean => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    };
    /** Same lookup order as normalization: absolute, else the run's cwd, else the workspace root. */
    const isFile = (file: string): boolean => {
      if (found.has(file)) return true;
      const ok = isAbsolute(file) ? regular(file) : regular(resolve(ctx.cwd, file)) || regular(resolve(ctx.root, file));
      if (ok) {
        // Bounded: a pathological stream of distinct paths must not grow the cache forever.
        if (found.size > 10_000) found.clear();
        found.add(file);
      }
      return ok;
    };
    return {
      line(text) {
        const m = LOCATION.exec(text);
        if (!m || Number(m[2]) < 1 || !isFile(m[1]!)) return { claimed: false };
        let message = m[6]!.trim();
        let code = m[5];
        const trailing = TRAILING_CODE.exec(message);
        if (trailing) {
          code ??= trailing[1] ?? trailing[2];
          message = message.slice(0, trailing.index);
        } else if (!m[4]) {
          const leading = LEADING_CODE.exec(message);
          if (leading) {
            code = leading[1];
            message = leading[2]!;
          }
        }
        const d: RawDiagnostic = { source: 'generic', severity: severity(m[4]), file: m[1]!, line: Number(m[2]), message };
        if (m[3]) d.column = Number(m[3]);
        if (code) d.code = code;
        return { claimed: true, diagnostics: [d] };
      },
      end: () => [],
    };
  },
};
