import { StringDecoder } from 'node:string_decoder';

/**
 * Matches the escape sequences terminals interpret: CSI (colors, cursor
 * moves), OSC terminated by BEL or ST (titles, OSC 8 hyperlinks, OSC 7501),
 * and the remaining two-byte ESC sequences.
 */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// Other C0 controls (except tab) and C1 controls carry no text.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Returns the visible text of one line: escape sequences removed, and for a
 * line redrawn with carriage returns (progress bars), only the last redraw.
 */
export function cleanLine(line: string): string {
  let text = line.replace(ANSI, '');
  if (text.endsWith('\r')) text = text.slice(0, -1);
  const cr = text.lastIndexOf('\r');
  if (cr !== -1) text = text.slice(cr + 1);
  return text.replace(CONTROL, '');
}

/** Lines longer than this are cut: a stream without newlines must not grow memory without bound. */
export const MAX_LINE_BYTES = 64 * 1024;

/**
 * Splits a byte stream into cleaned lines across arbitrary chunk boundaries,
 * including multibyte UTF-8 characters split between chunks.
 */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  /** Set after a line was cut at MAX_LINE_BYTES: its rest is dropped up to the next newline. */
  private skipping = false;

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let nl = this.pending.indexOf('\n');
    while (nl !== -1) {
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      if (this.skipping) this.skipping = false;
      else this.emit(line);
      nl = this.pending.indexOf('\n');
    }
    // Whatever the chunk boundaries, an overlong line yields the same cut prefix once.
    if (this.skipping) this.pending = '';
    else if (this.pending.length > MAX_LINE_BYTES) {
      this.emit(this.pending);
      this.pending = '';
      this.skipping = true;
    }
  }

  private emit(line: string): void {
    this.onLine(cleanLine(line.slice(0, MAX_LINE_BYTES)));
  }

  /** Flushes the last line, which may lack a trailing newline. */
  end(): void {
    this.pending += this.decoder.end();
    if (this.pending.length > 0 && !this.skipping) this.emit(this.pending);
    this.pending = '';
    this.skipping = false;
  }
}
