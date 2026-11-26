import { LineSplitter } from './lines.js';
import { normalize, type NormalizeContext } from './normalize.js';
import type { Parser, ParserSession } from './parsers/types.js';
import type { Diagnostic, RawDiagnostic } from './types.js';

/** Per-run cap on kept diagnostics; the rest are counted in `dropped`. */
export const MAX_DIAGNOSTICS_PER_RUN = 5000;

export interface StreamSink {
  push(chunk: Buffer | string): void;
  end(): void;
}

/**
 * The ingestion pipeline for one run: bytes from each output stream are split
 * into clean lines, offered to the parsers, normalized and deduplicated.
 * It knows nothing about specific tools: parsers come from the registry.
 */
export class Ingestor {
  private readonly seen = new Set<string>();
  readonly diagnostics: Diagnostic[] = [];
  dropped = 0;

  constructor(
    private readonly parsers: readonly Parser[],
    private readonly ctx: Omit<NormalizeContext, 'now'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** A sink for one stream. Each stream keeps its own parser state, so interleaved stdout and stderr never mix. */
  stream(): StreamSink {
    const sessions: Array<{ parser: Parser; session: ParserSession }> = this.parsers.map((parser) => ({
      parser,
      session: parser.create({ cwd: this.ctx.cwd, root: this.ctx.workspace.root }),
    }));
    const regular = sessions.filter((s) => !s.parser.fallback);
    const fallback = sessions.filter((s) => s.parser.fallback);
    const splitter = new LineSplitter((text) => {
      let claimed = false;
      for (const { session } of regular) {
        const r = session.line(text);
        if (r.diagnostics) this.add(r.diagnostics);
        if (r.claimed) {
          claimed = true;
          break;
        }
      }
      if (claimed) return;
      for (const { session } of fallback) {
        const r = session.line(text);
        if (r.diagnostics) this.add(r.diagnostics);
        if (r.claimed) break;
      }
    });
    return {
      push: (chunk) => splitter.push(chunk),
      end: () => {
        splitter.end();
        for (const { session } of sessions) this.add(session.end());
      },
    };
  }

  private add(raws: RawDiagnostic[]): void {
    for (const raw of raws) {
      const d = normalize(raw, { ...this.ctx, now: this.now() });
      if (!d || this.seen.has(d.id)) continue;
      if (this.diagnostics.length >= MAX_DIAGNOSTICS_PER_RUN) {
        this.dropped++;
        continue;
      }
      this.seen.add(d.id);
      this.diagnostics.push(d);
    }
  }
}
