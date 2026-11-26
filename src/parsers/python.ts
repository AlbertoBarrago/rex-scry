import { isAbsolute } from 'node:path';
import type { RawDiagnostic } from '../types.js';
import { appendLine, MAX_MESSAGE_CHARS, type Parser, type ParserSession } from './types.js';

// pytest location lines, `path.py:LINE: REST`. REST tells them apart:
//   tests/test_math.py:5: AssertionError   final location of a failure (--tb=long/auto)
//   tests/test_math.py:5: in test_add       a frame (--tb=short and inner frames)
//   tests/test_math.py:9:                   a frame (--tb=long inner frames)
//   /abs/tests/test_math.py:5: assert 3 == 4   one-line failure (--tb=line)
// They are only read inside pytest output (after a `===` banner or a `___` section):
// elsewhere `script.py:12: started worker` is just a log line.
const LOCATION = /^(.+\.py):(\d+): ?(.*)$/;
const OTHER_TOOL = /^(?:\d+:|(?:error|warning|note|info|hint)\b)/;
const EXC_NAME = /^[A-Za-z_][\w.]*$/;
const E_LINE = /^E\s+(.*)$/;
const SECTION = /^_{3,} (.+?) _{3,}$/;
const COLLECTING = /^ERROR collecting (.+\.py)$/;
const BANNER = /^={3,}/;
const SUMMARY = /^(FAILED|ERROR|PASSED|SKIPPED|XFAIL|XPASS) \S/;
// Python warnings, from pytest's warnings summary or any script:
//   /venv/lib/x.py:12: DeprecationWarning: use y instead
const WARNING = /^\s*(.+\.py):(\d+): ([A-Za-z_]\w*Warning): (.*)$/;

// Plain tracebacks. A SyntaxError has no "Traceback" header and its frame no ", in":
//   File "app.py", line 3
//     def f(:
//           ^
// SyntaxError: invalid syntax
const TRACEBACK = /^Traceback \(most recent call last\):$/;
const FRAME = /^\s+File "(.+)", line (\d+)(?:, in .*)?$/;
const EXCEPTION = /^([A-Za-z_][\w.]*)(?::\s?(.*))?$/;

/** At most this many `E` lines are kept per failure: messages are capped anyway. */
const MAX_E_LINES = 50;

interface Location {
  file: string;
  line: number;
}

/** pytest failures, Python warnings and plain Python tracebacks (SyntaxError included). */
export const pythonParser: Parser = {
  id: 'python',
  create(ctx): ParserSession {
    /** A frame in the user's code: relative, or under the run's cwd, and not an installed package. */
    const ownCode = (file: string): boolean =>
      !/[/\\](site|dist)-packages[/\\]|[/\\]lib[/\\]python\d/.test(file) && (!isAbsolute(file) || file.startsWith(`${ctx.cwd}/`));
    /**
     * The frame to report: the innermost one in the user's code, else the
     * innermost of all (a failure inside a library still has a location).
     */
    const pick = (frames: Location[]): Location | undefined => [...frames].reverse().find((f) => ownCode(f.file)) ?? frames.at(-1);

    // pytest state, reset at each failure section.
    let inPytest = false;
    let eLines: string[] = [];
    let frames: Location[] = [];
    let collecting: string | undefined;
    let reported = false;
    // Plain traceback state.
    let inTraceback = false;
    let tbFrames: Location[] = [];

    const pytestDiag = (loc: Location, message: string, code?: string): RawDiagnostic => {
      const d: RawDiagnostic = { source: 'pytest', severity: 'error', file: loc.file, line: loc.line, message };
      if (code) d.code = code;
      return d;
    };
    const eMessage = (fallback: string): string => {
      let msg = '';
      for (const l of eLines) {
        msg = msg ? appendLine(msg, l) : l;
        if (msg.length >= MAX_MESSAGE_CHARS) break;
      }
      return msg || fallback;
    };
    /** Ends a pytest failure section: emits it from its frames when no final location line came. */
    const closeSection = (): RawDiagnostic[] => {
      const out: RawDiagnostic[] = [];
      if (!reported && eLines.length > 0) {
        const loc = pick(frames);
        if (loc) out.push(pytestDiag(loc, eMessage('test failed')));
        else if (collecting) out.push(pytestDiag({ file: collecting, line: 1 }, eMessage('collection error')));
      }
      eLines = [];
      frames = [];
      collecting = undefined;
      reported = false;
      return out;
    };

    return {
      line(text) {
        if (inTraceback) {
          const f = FRAME.exec(text);
          if (f) {
            tbFrames.push({ file: f[1]!, line: Number(f[2]) });
            return { claimed: true };
          }
          if (/^\s/.test(text) || text === '') return { claimed: true };
          inTraceback = false;
          const ex = EXCEPTION.exec(text);
          const frame = pick(tbFrames);
          tbFrames = [];
          if (ex && frame) {
            const d: RawDiagnostic = { source: 'python', severity: 'error', file: frame.file, line: frame.line, message: text, code: ex[1]! };
            return { claimed: true, diagnostics: [d] };
          }
          return { claimed: false };
        }
        if (TRACEBACK.test(text)) {
          inTraceback = true;
          tbFrames = [];
          return { claimed: true };
        }

        const w = WARNING.exec(text);
        if (w) {
          return {
            claimed: true,
            diagnostics: [{ source: 'python', severity: 'warning', file: w[1]!.trim(), line: Number(w[2]), code: w[3]!, message: `${w[3]}: ${w[4]}` }],
          };
        }

        const section = SECTION.exec(text);
        if (section) {
          inPytest = true;
          const out = closeSection();
          const c = COLLECTING.exec(section[1]!);
          if (c) collecting = c[1];
          return { claimed: true, diagnostics: out };
        }
        if (BANNER.test(text)) {
          inPytest = true;
          return { claimed: true, diagnostics: closeSection() };
        }
        if (inPytest && SUMMARY.test(text)) return { claimed: true };

        if (inPytest) {
          const e = E_LINE.exec(text);
          if (e) {
            if (eLines.length < MAX_E_LINES) eLines.push(e[1]!);
            return { claimed: true };
          }
          const loc = LOCATION.exec(text);
          // `a.py:3:5: F401 ...` (ruff) and `a.py:3: error: ...` (mypy) are left to the generic parser.
          if (loc && !OTHER_TOOL.test(loc[3]!)) {
            const where = { file: loc[1]!, line: Number(loc[2]) };
            const rest = loc[3]!.trim();
            if (rest === '' || /^in \S+$/.test(rest)) {
              frames.push(where);
              return { claimed: true };
            }
            if (EXC_NAME.test(rest)) {
              reported = true;
              const d = pytestDiag(where, eMessage(rest), rest);
              eLines = [];
              return { claimed: true, diagnostics: [d] };
            }
            // --tb=line
            return { claimed: true, diagnostics: [pytestDiag(where, rest)] };
          }
        }

        // A SyntaxError (or any frame) printed without the "Traceback" header.
        const f = FRAME.exec(text);
        if (f) {
          inTraceback = true;
          tbFrames = [{ file: f[1]!, line: Number(f[2]) }];
          return { claimed: true };
        }
        return { claimed: false };
      },
      end() {
        const out = closeSection();
        inTraceback = false;
        return out;
      },
    };
  },
};
