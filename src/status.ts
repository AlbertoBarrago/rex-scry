import type { Diagnostic } from './types.js';

/**
 * Program Status Protocol (OSC 7501), documented by Rex at
 * https://www.superlogical.com/rex/docs/build/program-status. Rex shows these
 * records as tab spinners and session-picker indicators; terminals that do
 * not know the sequence ignore it. Only the record with id `rex-scry`
 * is touched, so the wrapped program's own root record is left alone.
 */
const RECORD_ID = 'rex-scry';
const APP = 'rex-scry';
/** Protocol limit on the encoded `msg`, checked before sending. */
const MAX_MSG_ENCODED = 2732;

function b64(text: string): string {
  // The protocol forbids control characters in decoded text.
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  let encoded = Buffer.from(clean, 'utf8').toString('base64');
  if (encoded.length > MAX_MSG_ENCODED) encoded = Buffer.from(clean.slice(0, 1500), 'utf8').toString('base64');
  return encoded;
}

export function statusSequence(state: 'working' | 'done' | 'error' | 'idle', msg: string): string {
  return `\x1b]7501;state=${state}:id=${RECORD_ID}:app=${APP}:title=${b64('diagnostics')}:msg=${b64(msg)}\x1b\\`;
}

/** "3 errors · 1 warning", or "no diagnostics". */
export function summarize(diagnostics: readonly Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  const others = diagnostics.length - errors - warnings;
  const parts: string[] = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  if (others) parts.push(`${others} other`);
  return parts.length ? parts.join(' · ') : 'no diagnostics';
}
