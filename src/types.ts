/**
 * The diagnostic contract shared by the store, the CLI's JSON output, the Rex
 * action and the Neovim plugin. Bump SCHEMA_VERSION on any breaking change to
 * these shapes: consumers check it before reading.
 */
export const SCHEMA_VERSION = 1;

export const SEVERITIES = ['error', 'warning', 'info', 'hint'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Lower rank sorts first (errors before warnings). */
export const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/**
 * One normalized diagnostic. Positions are one-based; `column` counts
 * characters as the tool reported them (tsc, rustc and ESLint all report
 * one-based columns). `file` is absolute; `relativeFile` is relative to the
 * workspace root when the file lies inside it.
 */
export interface Diagnostic {
  id: string;
  workspaceId: string;
  runId: string;
  paneId?: string;
  source: string;
  severity: Severity;
  message: string;
  file: string;
  relativeFile?: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  code?: string;
  timestamp: number;
}

/**
 * What a parser emits: positions as printed by the tool (already one-based for
 * every supported tool), the path exactly as printed. Normalization turns it
 * into a Diagnostic.
 */
export interface RawDiagnostic {
  source: string;
  severity: Severity;
  message: string;
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  code?: string;
}

export type RunStatus = 'running' | 'completed' | 'interrupted' | 'failed_to_start';

/** One execution of a wrapped command. */
export interface Run {
  runId: string;
  /** Groups executions of the same command: a finished run supersedes older runs with the same key. */
  commandKey: string;
  command: string[];
  cwd: string;
  paneId?: string;
  pid: number;
  host: string;
  /** Order within the workspace, assigned under the store lock when the run starts. */
  seq?: number;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  exitCode?: number;
  signal?: string;
  /** Diagnostics the run found beyond the per-run cap and did not keep. */
  dropped: number;
  diagnostics: Diagnostic[];
}

export interface Workspace {
  workspaceId: string;
  root: string;
}
