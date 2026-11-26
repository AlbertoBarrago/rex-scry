import type { RawDiagnostic } from '../types.js';

/** What a parser session answers for one line. */
export interface LineResult {
  /** The line belongs to this parser's format (even if it emitted nothing yet). Claimed lines are not offered to fallback parsers. */
  claimed: boolean;
  diagnostics?: RawDiagnostic[];
}

/**
 * Parses one output stream (stdout or stderr) of one run. Sessions are
 * stateful so they can assemble multiline diagnostics; each stream gets its
 * own session, so interleaved stdout and stderr never mix their state.
 */
export interface ParserSession {
  line(text: string): LineResult;
  /** Called once when the stream ends: emit anything still pending. */
  end(): RawDiagnostic[];
}

export interface ParserContext {
  /** Working directory of the run, used by parsers that must check a path exists. */
  cwd: string;
  /** Workspace root: tools in monorepos and cargo workspaces print paths relative to it. */
  root: string;
}

/**
 * A parser for one tool's output format. Adding a tool means adding a Parser
 * to the registry (src/parsers/index.ts); the ingestion pipeline never changes.
 */
export interface Parser {
  /** Stable identifier, also the `source` of the diagnostics it emits unless it sets one itself. */
  id: string;
  /**
   * Fallback parsers only see lines that no regular parser claimed, so a
   * permissive format (file:line: message) never duplicates a tool-specific one.
   */
  fallback?: boolean;
  create(ctx: ParserContext): ParserSession;
}

/** Joins continuation lines into a message, bounded so a runaway diagnostic cannot grow memory. */
export const MAX_MESSAGE_CHARS = 4000;

export function appendLine(message: string, line: string): string {
  if (message.length >= MAX_MESSAGE_CHARS) return message;
  return `${message}\n${line}`.slice(0, MAX_MESSAGE_CHARS);
}
