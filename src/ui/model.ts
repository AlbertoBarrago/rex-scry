import { SEVERITY_RANK, type Diagnostic, type Severity } from '../types.js';

/** What the panel shows, cycled with `f`: everything, errors only, warnings only. */
export const FILTERS = ['all', 'error', 'warning'] as const;
export type Filter = (typeof FILTERS)[number];

/** How rows are grouped, cycled with `tab`. */
export const GROUPS = ['file', 'source', 'none'] as const;
export type Grouping = (typeof GROUPS)[number];

export interface Counts {
  error: number;
  warning: number;
  info: number;
  hint: number;
}

export function countBySeverity(diags: readonly Diagnostic[]): Counts {
  const c: Counts = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const d of diags) c[d.severity]++;
  return c;
}

/** One line of the list: a group heading, or a diagnostic. */
export type Row =
  | { kind: 'group'; key: string; label: string; counts: Counts }
  | { kind: 'diag'; key: string; diagnostic: Diagnostic; number: number };

export function applyFilter(diags: readonly Diagnostic[], filter: Filter): Diagnostic[] {
  return filter === 'all' ? [...diags] : diags.filter((d) => d.severity === filter);
}

function groupKey(d: Diagnostic, grouping: Grouping): string {
  return grouping === 'file' ? (d.relativeFile ?? d.file) : grouping === 'source' ? d.source : '';
}

/**
 * Builds the rows of the list. Diagnostics keep the store's order (severity,
 * file, position) inside each group; groups are ordered by their worst
 * severity, then by name, so the files with errors come first. `number` is
 * the diagnostic's position among the shown ones, as `list` would number it.
 */
export function buildRows(diags: readonly Diagnostic[], grouping: Grouping): Row[] {
  if (grouping === 'none') return diags.map((d, i) => ({ kind: 'diag', key: d.id, diagnostic: d, number: i + 1 }));
  const groups = new Map<string, Diagnostic[]>();
  for (const d of diags) {
    const k = groupKey(d, grouping);
    const list = groups.get(k);
    if (list) list.push(d);
    else groups.set(k, [d]);
  }
  const worst = (list: Diagnostic[]): number => Math.min(...list.map((d) => SEVERITY_RANK[d.severity]));
  const ordered = [...groups.entries()].sort(([a, la], [b, lb]) => worst(la) - worst(lb) || (a < b ? -1 : a > b ? 1 : 0));
  const rows: Row[] = [];
  let n = 0;
  for (const [label, list] of ordered) {
    rows.push({ kind: 'group', key: `group:${label}`, label, counts: countBySeverity(list) });
    for (const d of list) rows.push({ kind: 'diag', key: d.id, diagnostic: d, number: ++n });
  }
  return rows;
}

export type Move = 'down' | 'up' | 'top' | 'bottom' | 'pageDown' | 'pageUp';

/** Indexes of the rows the cursor can stand on (diagnostics, not headings). */
function selectable(rows: readonly Row[]): number[] {
  return rows.flatMap((r, i) => (r.kind === 'diag' ? [i] : []));
}

/**
 * Where the cursor is: the row of the selected diagnostic id, or, when that
 * diagnostic is gone (fixed, filtered out), the first diagnostic. The cursor
 * is anchored to the id because every refresh rebuilds the rows.
 */
export function resolveCursor(rows: readonly Row[], selectedId: string | undefined): number | undefined {
  const sel = selectable(rows);
  if (sel.length === 0) return undefined;
  const at = selectedId === undefined ? -1 : rows.findIndex((r) => r.kind === 'diag' && r.key === selectedId);
  return at === -1 ? sel[0] : at;
}

/** The diagnostic id the cursor lands on after a move. `page` is how many diagnostics a page holds. */
export function moveCursor(rows: readonly Row[], selectedId: string | undefined, move: Move, page = 10): string | undefined {
  const sel = selectable(rows);
  if (sel.length === 0) return undefined;
  const current = resolveCursor(rows, selectedId)!;
  const pos = sel.indexOf(current);
  const target = {
    down: pos + 1,
    up: pos - 1,
    top: 0,
    bottom: sel.length - 1,
    pageDown: pos + page,
    pageUp: pos - page,
  }[move];
  const row = rows[sel[Math.max(0, Math.min(sel.length - 1, target))]!]!;
  return row.key;
}

/**
 * First visible row for a viewport of `limit` rows that keeps `selected`
 * centered (vim `scrolloff=999`), as in rex-usage: stateless, so a refresh
 * that reorders rows never leaves the cursor off screen.
 */
export function viewportStart(total: number, limit: number, selected: number | undefined): number {
  if (selected === undefined || total <= limit) return 0;
  return Math.max(0, Math.min(total - limit, selected - Math.floor(limit / 2)));
}

export const SEVERITY_COLOR: Record<Severity, string> = {
  error: '#ff5f87',
  warning: '#ffd75f',
  info: '#5fd7ff',
  hint: '#8787af',
};

export const SEVERITY_LABEL: Record<Severity, string> = { error: 'ERR', warning: 'WRN', info: 'INF', hint: 'HNT' };
