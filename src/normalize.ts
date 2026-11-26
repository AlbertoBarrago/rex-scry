import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MAX_MESSAGE_CHARS } from './parsers/types.js';
import type { Diagnostic, RawDiagnostic, Workspace } from './types.js';
import { physicalPath } from './workspace.js';

export interface NormalizeContext {
  cwd: string;
  workspace: Workspace;
  runId: string;
  paneId?: string;
  now: number;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves a path as a tool printed it. Relative paths are tried against the
 * run's cwd, then the workspace root (cargo prints paths relative to the
 * package, tsc -b relative to the project); the first existing one wins.
 * An existing file gets its physical path, so it matches rex-nvim's registry.
 */
export function resolveFile(file: string, cwd: string, root: string): string | undefined {
  let path = file;
  if (file.startsWith('file://')) {
    // Untrusted text: a malformed URL rejects the diagnostic instead of throwing.
    try {
      path = decodeURIComponent(new URL(file).pathname);
    } catch {
      return undefined;
    }
  }
  // Decoding can produce control characters a cleaned line did not contain.
  if (/[\x00-\x1f\x7f-\x9f]/.test(path)) return undefined;
  if (isAbsolute(path)) return isFile(path) ? physicalPath(path) : resolve(path);
  const candidates = [resolve(cwd, path), resolve(root, path)];
  path = candidates.find(isFile) ?? candidates[0]!;
  return isFile(path) ? physicalPath(path) : path;
}

/** The path relative to root, or undefined when it lies outside it. */
export function insideRoot(file: string, root: string): string | undefined {
  const rel = relative(root, file);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel;
}

// Keep newlines (multiline messages) and tabs; drop every other control character.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

function cleanMessage(message: string): string {
  return message.replace(CONTROL, '').trim().slice(0, MAX_MESSAGE_CHARS);
}

function positive(n: number | undefined): number | undefined {
  return n !== undefined && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/**
 * The fingerprint of a diagnostic: the same problem reported twice (in one
 * run, or by two runs of the same command) gets the same id.
 */
export function diagnosticId(d: Omit<Diagnostic, 'id' | 'runId' | 'timestamp' | 'paneId' | 'relativeFile'>): string {
  const key = JSON.stringify([d.workspaceId, d.source, d.severity, d.file, d.line, d.column ?? 0, d.code ?? '', d.message]);
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Turns a parser's raw diagnostic into the stored shape, or undefined when it has no usable location. */
export function normalize(raw: RawDiagnostic, ctx: NormalizeContext): Diagnostic | undefined {
  const line = positive(raw.line);
  const message = cleanMessage(raw.message);
  if (line === undefined || raw.file.trim() === '' || message === '') return undefined;
  const file = resolveFile(raw.file.trim(), ctx.cwd, ctx.workspace.root);
  if (file === undefined) return undefined;
  const base = {
    workspaceId: ctx.workspace.workspaceId,
    source: raw.source.toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'unknown',
    severity: raw.severity,
    message,
    file,
    line,
    ...(positive(raw.column) !== undefined ? { column: positive(raw.column) } : {}),
    ...(positive(raw.endLine) !== undefined ? { endLine: positive(raw.endLine) } : {}),
    ...(positive(raw.endColumn) !== undefined ? { endColumn: positive(raw.endColumn) } : {}),
    ...(raw.code ? { code: raw.code } : {}),
  };
  const rel = insideRoot(file, ctx.workspace.root);
  return {
    id: diagnosticId(base),
    runId: ctx.runId,
    ...(ctx.paneId ? { paneId: ctx.paneId } : {}),
    ...base,
    ...(rel !== undefined ? { relativeFile: rel } : {}),
    timestamp: ctx.now,
  };
}
