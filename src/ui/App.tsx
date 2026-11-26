import { Box, type Key, Text, useApp, useInput, useWindowSize } from 'ink';
import { watch } from 'node:fs';
import { basename } from 'node:path';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { currentDiagnostics, readState, statePath, type WorkspaceState } from '../store.js';
import type { Workspace } from '../types.js';
import { clearAll, copy, openFromPanel, plainLine, type Status } from './actions.js';
import { Detail } from './Detail.js';
import { Header } from './Header.js';
import { List } from './List.js';
import { applyFilter, buildRows, countBySeverity, FILTERS, type Filter, GROUPS, type Grouping, type Move, moveCursor, resolveCursor } from './model.js';

interface Props {
  workspace: Workspace;
  stateDir: string;
  initialFilter: Filter;
}

/** Fallback poll, for file systems where watching is unreliable; the watcher normally refreshes first. */
const POLL_MS = 5_000;
/** Clock tick for the live dot and the "12s ago" texts. */
const TICK_MS = 1_000;
/** Below this height the banner collapses and the detail box shrinks. */
const FULL_LAYOUT_MIN_ROWS = 30;

/** A plain printable key, used when replaying batched input. Typed as `Key` so new Ink fields fail the build. */
const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

const TONE: Record<Status['tone'], string> = { ok: 'green', warn: '#ffd75f', error: '#ff5f87' };

export function App({ workspace, stateDir, initialFilter }: Props) {
  const { exit } = useApp();
  const { columns: width, rows: height } = useWindowSize();
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [filterIdx, setFilterIdx] = useState(() => Math.max(0, FILTERS.indexOf(initialFilter)));
  const [groupIdx, setGroupIdx] = useState(0);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [status, setStatus] = useState<Status | undefined>();
  const [confirmClear, setConfirmClear] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const tick = Math.floor(now / TICK_MS);

  const load = useCallback(() => {
    try {
      setState(readState(workspace, stateDir));
      setLoadError(undefined);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [workspace, stateDir]);

  // Refresh when the state file is replaced (runs finishing, `clear`), with a poll as a safety net.
  const debounce = useRef<NodeJS.Timeout | undefined>(undefined);
  useEffect(() => {
    load();
    const file = basename(statePath(workspace, stateDir));
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      watcher = watch(stateDir, (_event, name) => {
        if (name !== file) return;
        clearTimeout(debounce.current);
        debounce.current = setTimeout(load, 100);
      });
    } catch {
      // No watch support: the poll below still refreshes.
    }
    const poll = setInterval(load, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      watcher?.close();
      clearInterval(poll);
      clearInterval(clock);
      clearTimeout(debounce.current);
    };
  }, [load, workspace, stateDir]);

  const filter = FILTERS[filterIdx] ?? 'all';
  const grouping: Grouping = GROUPS[groupIdx] ?? 'file';
  const all = useMemo(() => (state ? currentDiagnostics(state) : []), [state]);
  const shown = useMemo(() => applyFilter(all, filter), [all, filter]);
  const rows = useMemo(() => buildRows(shown, grouping), [shown, grouping]);
  const cursor = resolveCursor(rows, selectedId);
  const current = cursor === undefined ? undefined : rows[cursor];
  const selected = current?.kind === 'diag' ? current.diagnostic : undefined;
  const run = selected && state ? state.runs.find((r) => r.runId === selected.runId) : undefined;

  // Layout: header (6 or 9 rows), detail box (message lines + 4), key bar (1), list gets the rest.
  const compact = height < FULL_LAYOUT_MIN_ROWS;
  const detailLines = compact ? 2 : 5;
  const detailRows = selected ? Math.min(detailLines, selected.message.split('\n').length) + 4 + (run ? 1 : 0) : 0;
  const headerRows = compact ? 6 : 9;
  const listRows = Math.max(3, height - headerRows - detailRows - 4);

  const move = (m: Move) => setSelectedId(moveCursor(rows, selectedId, m, Math.max(1, Math.floor(listRows / 2))));

  const onKey = (input: string, key: Key) => {
    if (confirmClear && input !== 'c') setConfirmClear(false);
    if (input === 'q' || (key.ctrl && input === 'c')) exit();
    else if (key.downArrow || input === 'j') move('down');
    else if (key.upArrow || input === 'k') move('up');
    else if (key.home || input === 'g') move('top');
    else if (key.end || input === 'G') move('bottom');
    else if (key.pageDown || (key.ctrl && input === 'd')) move('pageDown');
    else if (key.pageUp || (key.ctrl && input === 'u')) move('pageUp');
    else if (key.tab) setGroupIdx((i) => (i + 1) % GROUPS.length);
    else if (input === 'f') setFilterIdx((i) => (i + 1) % FILTERS.length);
    else if (input === 'e') setFilterIdx(FILTERS.indexOf('error'));
    else if (input === 'w') setFilterIdx(FILTERS.indexOf('warning'));
    else if (input === 'a') setFilterIdx(FILTERS.indexOf('all'));
    else if (input === 'r') {
      load();
      setStatus({ text: 'refreshed', tone: 'ok' });
    } else if ((key.return || input === 'o' || input === 'l') && selected) setStatus(openFromPanel(selected, workspace, stateDir));
    else if (input === 'y' && selected) setStatus(copy(plainLine(selected)));
    else if (input === 'c') {
      if (!confirmClear) {
        setConfirmClear(true);
        setStatus({ text: 'press c again to clear every diagnostic of this workspace', tone: 'warn' });
      } else {
        setConfirmClear(false);
        setStatus(clearAll(workspace, stateDir));
        load();
      }
    }
  };

  useInput((input, key) => {
    // Key repeat and `rex send jjj` deliver several characters at once: replay them one by one.
    if (input.length > 1 && !key.ctrl && !key.meta && /^[jkgGfewarcyoql]+$/.test(input)) {
      for (const ch of input) onKey(ch, NO_KEY);
      return;
    }
    onKey(input, key);
  });

  const counts = countBySeverity(all);
  const emptyText = all.length === 0 ? 'No diagnostics. Run a build with: rex-diagnostics run -- <command>' : `No ${filter}s. Press a to show all.`;

  return (
    <Box flexDirection="column" paddingX={1} height={height}>
      <Header
        root={workspace.root}
        counts={counts}
        runs={state?.runs ?? []}
        filter={filter}
        grouping={grouping}
        tick={tick}
        now={now}
        width={width}
        compact={compact}
      />
      {loadError ? (
        <Box borderStyle="single" borderColor="#ff5f87" paddingX={1}>
          <Text color="#ff5f87">{loadError}</Text>
        </Box>
      ) : (
        <List rows={rows} selected={cursor} limit={listRows} withFile={grouping !== 'file'} empty={emptyText} />
      )}
      <Detail diagnostic={selected} run={run} lines={detailLines} />
      <Text wrap="truncate">
        {status ? (
          <Text color={TONE[status.tone]}>{status.text}</Text>
        ) : (
          <Text dimColor>
            <Text color="#ff5fd7">j/k</Text> move  <Text color="#ff5fd7">enter</Text> open  <Text color="#ff5fd7">e/w/a</Text> errors/warnings/all
            {'  '}
            <Text color="#ff5fd7">tab</Text> group  <Text color="#ff5fd7">y</Text> copy  <Text color="#ff5fd7">c</Text> clear  <Text color="#ff5fd7">q</Text> quit
          </Text>
        )}
      </Text>
    </Box>
  );
}
