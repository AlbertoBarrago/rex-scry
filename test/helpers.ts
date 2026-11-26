import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ingestor } from '../src/pipeline.js';
import { PARSERS } from '../src/parsers/index.js';
import type { Parser } from '../src/parsers/types.js';
import type { Diagnostic, Workspace } from '../src/types.js';
import { workspaceIdOf } from '../src/workspace.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function fixture(name: string): string {
  return readFileSync(join(ROOT, 'test', 'fixtures', name), 'utf8');
}

/** A fresh temp dir (physical path), with the given files created in it. */
export function tempDir(files: Record<string, string> = {}): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'rex-scry-')));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

export function workspace(root: string): Workspace {
  return { root, workspaceId: workspaceIdOf(root) };
}

/**
 * Runs text through the real pipeline, in chunks of `chunk` bytes (all at
 * once by default), as if a command printed it on stdout.
 */
export function parse(
  text: string,
  opts: { cwd?: string; root?: string; parsers?: readonly Parser[]; chunk?: number; runId?: string } = {},
): Diagnostic[] {
  const cwd = opts.cwd ?? '/work';
  const ing = new Ingestor(opts.parsers ?? PARSERS, { cwd, workspace: workspace(opts.root ?? cwd), runId: opts.runId ?? 'run_test' }, () => 1000);
  const sink = ing.stream();
  const bytes = Buffer.from(text, 'utf8');
  const size = opts.chunk ?? bytes.length;
  for (let i = 0; i < bytes.length; i += size) sink.push(bytes.subarray(i, i + size));
  sink.end();
  return ing.diagnostics;
}

/** The fields tests usually compare, with the path relative to the workspace when possible. */
export function brief(d: Diagnostic): Record<string, unknown> {
  return {
    source: d.source,
    severity: d.severity,
    file: d.relativeFile ?? d.file,
    line: d.line,
    ...(d.column ? { column: d.column } : {}),
    ...(d.code ? { code: d.code } : {}),
    message: d.message,
  };
}
