import { Box, Text } from 'ink';
import { location } from '../open.js';
import { safe } from '../format.js';
import type { Diagnostic, Run } from '../types.js';
import { SEVERITY_COLOR } from './model.js';

interface Props {
  diagnostic: Diagnostic | undefined;
  run: Run | undefined;
  /** Lines available for the message. */
  lines: number;
}

/** The selected diagnostic in full: location, tool, code, the whole message and the command that reported it. */
export function Detail({ diagnostic: d, run, lines }: Props) {
  if (!d) return null;
  const message = d.message.split('\n').map(safe);
  const shown = message.slice(0, lines);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={SEVERITY_COLOR[d.severity]} paddingX={1}>
      <Text wrap="truncate">
        <Text bold color={SEVERITY_COLOR[d.severity]}>
          {d.severity.toUpperCase()}
        </Text>
        <Text bold> {safe(location(d, d.relativeFile ?? d.file))}</Text>
        <Text dimColor>
          {'  '}
          {d.source}
          {d.code ? ` ${d.code}` : ''}
        </Text>
      </Text>
      {shown.map((l, i) => (
        <Text key={i} wrap="truncate">
          {l}
        </Text>
      ))}
      {message.length > shown.length && <Text dimColor>… {message.length - shown.length} more lines</Text>}
      {run && (
        <Text dimColor wrap="truncate">
          from {safe(run.command.join(' '))}
        </Text>
      )}
    </Box>
  );
}
