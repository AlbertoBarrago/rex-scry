import { Box, Text } from 'ink';
import { homedir } from 'node:os';
import { ago, safe } from '../format.js';
import type { Run } from '../types.js';
import type { Counts, Filter, Grouping } from './model.js';
import { SEVERITY_COLOR } from './model.js';

const BANNER = [
  '█▀█ █▀▀ ▀▄▀ ╱╱ █▀▄ █ ▄▀█ █▀▀ █▄ █ █▀█ █▀ ▀█▀ █ █▀▀ █▀',
  '█▀▄ ██▄ █ █ ╱╱ █▄▀ █ █▀█ █▄█ █ ▀█ █▄█ ▄█  █  █ █▄▄ ▄█',
];
/** Vertical gradient, one color per banner row (the rex-usage palette). */
const GRADIENT = ['#ff5fd7', '#8787ff'];
/** The two-row banner needs this many columns; narrower panes get the one-line title. */
const BANNER_WIDTH = 58;

interface Props {
  root: string;
  counts: Counts;
  runs: readonly Run[];
  filter: Filter;
  grouping: Grouping;
  tick: number;
  now: number;
  width: number;
  compact: boolean;
}

function Tile({ label, value, color, dim }: { label: string; value: string; color: string; dim?: boolean }) {
  return (
    <Box flexDirection="column" marginRight={3} flexShrink={0}>
      <Text dimColor>{label}</Text>
      <Text bold color={dim ? 'gray' : color}>
        {value}
      </Text>
    </Box>
  );
}

/** The run in progress (pulsing), else the last finished one: where the list comes from. */
function RunLine({ runs, tick, now }: { runs: readonly Run[]; tick: number; now: number }) {
  const running = runs.filter((r) => r.status === 'running');
  const cmd = (r: Run): string => safe(r.command.join(' '));
  if (running.length > 0) {
    const r = running.at(-1)!;
    return (
      <Text wrap="truncate">
        <Text color="green">{tick % 2 ? '●' : '○'} running </Text>
        <Text>{cmd(r)}</Text>
        <Text dimColor>
          {'  '}
          {ago(now - r.startedAt)}
          {running.length > 1 ? ` · +${running.length - 1} more` : ''}
        </Text>
      </Text>
    );
  }
  const last = runs.filter((r) => r.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  if (!last) return <Text dimColor>no runs yet · rex-diagnostics run -- &lt;command&gt;</Text>;
  const ok = last.status === 'completed' && last.exitCode === 0;
  const how =
    last.status === 'interrupted'
      ? `interrupted${last.signal ? ` (${last.signal})` : ''}`
      : last.status === 'failed_to_start'
        ? 'failed to start'
        : `exit ${last.exitCode ?? '?'}`;
  return (
    <Text wrap="truncate">
      <Text color={ok ? 'green' : '#ff5f87'}>{ok ? '✔' : '✖'} </Text>
      <Text>{cmd(last)}</Text>
      <Text dimColor>
        {'  '}
        {ago(now - (last.endedAt ?? last.startedAt))} ago · {how}
      </Text>
    </Text>
  );
}

export function Header({ root, counts, runs, filter, grouping, tick, now, width, compact }: Props) {
  const banner = !compact && width >= BANNER_WIDTH + 30;
  const name = root.split('/').filter(Boolean).at(-1) ?? root;
  const home = homedir();
  const shownRoot = root === home || root.startsWith(`${home}/`) ? `~${root.slice(home.length)}` : root;
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        {banner ? (
          <Box flexDirection="column" flexShrink={0}>
            {BANNER.map((line, i) => (
              <Text key={i} color={GRADIENT[i]}>
                {line}
              </Text>
            ))}
          </Box>
        ) : (
          <Text bold color={GRADIENT[0]}>
            REX<Text color={GRADIENT[1]}>//DIAGNOSTICS</Text>
          </Text>
        )}
        <Box flexDirection="column" alignItems="flex-end" flexShrink={1} marginLeft={2}>
          <Text bold color="#ffd75f" wrap="truncate">
            {safe(name)}
          </Text>
          {banner && (
            <Text dimColor wrap="truncate">
              {safe(shownRoot)}
            </Text>
          )}
        </Box>
      </Box>
      <Box marginTop={banner ? 1 : 0} borderStyle="round" borderColor="#5f5f87" paddingX={1} flexDirection="column">
        <Box>
          <Tile label="errors" value={String(counts.error)} color={SEVERITY_COLOR.error} dim={counts.error === 0} />
          <Tile label="warnings" value={String(counts.warning)} color={SEVERITY_COLOR.warning} dim={counts.warning === 0} />
          <Tile label="info" value={String(counts.info + counts.hint)} color={SEVERITY_COLOR.info} dim={counts.info + counts.hint === 0} />
          <Tile label="showing" value={filter === 'all' ? 'all' : `${filter}s`} color="#d7afff" />
          <Tile label="grouped by" value={grouping} color="#87d787" />
        </Box>
        <RunLine runs={runs} tick={tick} now={now} />
      </Box>
    </Box>
  );
}
