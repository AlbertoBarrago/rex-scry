import { location } from './open.js';
import { summarize } from './status.js';
import type { WorkspaceState } from './store.js';
import { SCHEMA_VERSION, type Diagnostic, type Run } from './types.js';

export type GroupBy = 'file' | 'source' | 'none';

const LABEL: Record<Diagnostic['severity'], string> = { error: 'ERROR', warning: 'WARNING', info: 'INFO', hint: 'HINT' };
const COLOR: Record<Diagnostic['severity'], string> = { error: '31', warning: '33', info: '36', hint: '2' };

function paint(on: boolean, code: string, text: string): string {
  return on ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/**
 * Removes escape and control characters before showing untrusted text on a
 * terminal: a message must never be able to drive the terminal that lists it.
 */
export function safe(text: string): string {
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
}

function display(d: Diagnostic): string {
  return safe(location(d, d.relativeFile ?? d.file));
}

/** "12s", "4 min", "3 h", "2 d". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

/** One line per running run, then the newest finished one: where the listed diagnostics come from. */
export function runLines(runs: readonly Run[], now: number, color: boolean): string[] {
  const lines: string[] = [];
  const cmd = (r: Run): string => safe(r.command.join(' ')).slice(0, 80);
  for (const r of runs.filter((r) => r.status === 'running')) {
    lines.push(`${paint(color, '33', '● running')}  ${cmd(r)}  ${paint(color, '2', `since ${ago(now - r.startedAt)}`)}`);
  }
  const last = runs.filter((r) => r.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  if (last) {
    const how =
      last.status === 'interrupted'
        ? `interrupted${last.signal ? ` (${last.signal})` : ''}`
        : last.status === 'failed_to_start'
          ? 'failed to start'
          : `exit ${last.exitCode ?? '?'}`;
    lines.push(`${paint(color, '2', 'last run')}  ${cmd(last)}  ${paint(color, '2', `${ago(now - (last.endedAt ?? last.startedAt))} ago · ${how}`)}`);
  }
  return lines;
}

/** The human listing, numbered so `rex-diagnostics open N` can pick an entry. */
export function formatText(
  diags: readonly Diagnostic[],
  opts: { color: boolean; group: GroupBy; runs?: readonly Run[]; now?: number; missing?: (file: string) => boolean },
): string {
  const footer = opts.runs ? runLines(opts.runs, opts.now ?? Date.now(), opts.color) : [];
  const lines: string[] = [];
  const header = 'DIAGNOSTICS';
  const summary = diags.length ? summarize(diags) : '';
  lines.push(`${paint(opts.color, '1', header)}${summary ? `  ${summary}` : ''}`);
  if (diags.length === 0) {
    lines.push('', '  No diagnostics. Run a build through `rex-diagnostics run -- <command>`.');
    if (footer.length) lines.push('', ...footer);
    return `${lines.join('\n')}\n`;
  }
  const width = String(diags.length).length;
  let lastGroup: string | undefined;
  diags.forEach((d, i) => {
    if (opts.group !== 'none') {
      const g = opts.group === 'file' ? safe(d.relativeFile ?? d.file) : d.source;
      if (g !== lastGroup) {
        lines.push('', paint(opts.color, '1', g));
        lastGroup = g;
      }
    } else if (i === 0) {
      lines.push('');
    }
    const n = String(i + 1).padStart(width);
    const label = paint(opts.color, COLOR[d.severity], LABEL[d.severity].padEnd(8));
    const extra = [d.code, d.source].filter(Boolean).join(' ');
    const gone = opts.missing?.(d.file) ? paint(opts.color, '33', '  (file not found)') : '';
    lines.push(`  ${n}  ${label} ${display(d)}  ${paint(opts.color, '2', extra)}${gone}`);
    const [first = '', ...rest] = d.message.split('\n');
    lines.push(`  ${' '.repeat(width)}           ${safe(first)}`);
    for (const r of rest.slice(0, 3)) lines.push(`  ${' '.repeat(width)}           ${paint(opts.color, '2', safe(r))}`);
  });
  if (footer.length) lines.push('', ...footer);
  return `${lines.join('\n')}\n`;
}

/**
 * One diagnostic per line, in a format Vim's default 'errorformat' and most
 * editors read: `FILE:LINE:COL: SEVERITY: MESSAGE`. Message newlines become
 * spaces so each diagnostic stays on one line.
 */
export function formatPlain(diags: readonly Diagnostic[]): string {
  return diags
    .map((d) => {
      const code = d.code ? ` [${d.code}]` : '';
      // Newlines are removed from the path as well: one diagnostic, one line.
      return `${safe(location(d)).replace(/\n/g, ' ')}: ${d.severity}: ${safe(d.message.replace(/\s*\n\s*/g, ' '))}${code}`;
    })
    .map((l) => `${l}\n`)
    .join('');
}

/** Run metadata without the diagnostics (they are listed once, at the top level). */
function runSummary(r: Run): Omit<Run, 'diagnostics' | 'pid' | 'host'> & { diagnosticCount: number } {
  const { diagnostics, pid: _pid, host: _host, ...rest } = r;
  return { ...rest, diagnosticCount: diagnostics.length };
}

/**
 * The JSON contract for scripts and agents. Deterministic: same store, same
 * bytes (sorted diagnostics, runs by start time, fixed key order).
 */
export function formatJson(state: WorkspaceState, diags: readonly Diagnostic[]): string {
  const runs = [...state.runs].sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : 1)).map(runSummary);
  const out = {
    schemaVersion: SCHEMA_VERSION,
    workspace: { workspaceId: state.workspaceId, root: state.root },
    counts: {
      error: diags.filter((d) => d.severity === 'error').length,
      warning: diags.filter((d) => d.severity === 'warning').length,
      info: diags.filter((d) => d.severity === 'info').length,
      hint: diags.filter((d) => d.severity === 'hint').length,
    },
    runs,
    diagnostics: diags,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}
