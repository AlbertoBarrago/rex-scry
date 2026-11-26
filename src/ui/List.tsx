import { Box, Text } from 'ink';
import { safe } from '../format.js';
import { type Row, SEVERITY_COLOR, SEVERITY_LABEL, viewportStart } from './model.js';

interface Props {
  rows: readonly Row[];
  /** Row index of the cursor. */
  selected: number | undefined;
  limit: number;
  /** Show the file in each row (when rows are not grouped by file). */
  withFile: boolean;
  empty: string;
}

function position(line: number, column: number | undefined): string {
  return `${line}${column ? `:${column}` : ''}`;
}

/**
 * The scrolling list. Each row is one Text with nested colored spans, so Ink
 * truncates the whole line instead of wrapping cells (the rex-usage pattern).
 */
export function List({ rows, selected, limit, withFile, empty }: Props) {
  const start = viewportStart(rows.length, limit, selected);
  const visible = rows.slice(start, start + limit);
  const below = rows.length - start - visible.length;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="#5f5f87" paddingX={1} flexGrow={1}>
      {rows.length === 0 && <Text dimColor>{empty}</Text>}
      {visible.map((row, j) => {
        const i = start + j;
        if (row.kind === 'group') {
          const c = row.counts;
          return (
            <Text key={row.key} wrap="truncate">
              <Text bold color="#ff5fd7">
                {safe(row.label)}
              </Text>
              {c.error > 0 && <Text color={SEVERITY_COLOR.error}>{`  ${c.error}✖`}</Text>}
              {c.warning > 0 && <Text color={SEVERITY_COLOR.warning}>{`  ${c.warning}▲`}</Text>}
              {c.info + c.hint > 0 && <Text color={SEVERITY_COLOR.info}>{`  ${c.info + c.hint}●`}</Text>}
            </Text>
          );
        }
        const d = row.diagnostic;
        const sel = i === selected;
        const where = withFile ? `${safe(d.relativeFile ?? d.file)}:${position(d.line, d.column)}` : position(d.line, d.column);
        const first = safe(d.message.split('\n')[0] ?? '');
        return (
          <Text key={row.key} wrap="truncate">
            <Text color="#ff5fd7">{sel ? '▸ ' : '  '}</Text>
            <Text color={SEVERITY_COLOR[d.severity]} bold inverse={sel}>
              {` ${SEVERITY_LABEL[d.severity]} `}
            </Text>
            <Text color={sel ? '#ff5fd7' : '#87afff'} bold={sel}>
              {` ${where.padEnd(withFile ? 0 : 8)} `}
            </Text>
            <Text bold={sel}>{first}</Text>
            <Text dimColor>{d.code ? `  ${d.code}` : ''}</Text>
          </Text>
        );
      })}
      {rows.length > limit && (
        <Text dimColor>
          {start > 0 ? `▲ ${start} above` : ''}
          {start > 0 && below > 0 ? ' · ' : ''}
          {below > 0 ? `▼ ${below} below` : ''}
        </Text>
      )}
    </Box>
  );
}
