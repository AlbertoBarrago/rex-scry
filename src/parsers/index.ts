import { eslintParser } from './eslint.js';
import { genericParser } from './generic.js';
import { pythonParser } from './python.js';
import { rustParser } from './rust.js';
import { tscParser } from './tsc.js';
import type { Parser } from './types.js';

/**
 * Every parser the pipeline runs. Order matters only among regular parsers
 * that could claim the same line: the first claim wins. Fallback parsers run
 * after all regular ones, on unclaimed lines only.
 */
export const PARSERS: readonly Parser[] = [tscParser, eslintParser, rustParser, pythonParser, genericParser];

export function parserIds(): string[] {
  return PARSERS.map((p) => p.id);
}

/** Picks parsers by id; unknown ids throw so a typo in --parser is reported, not ignored. */
export function selectParsers(ids: string[] | undefined): Parser[] {
  if (!ids || ids.length === 0) return [...PARSERS];
  return ids.map((id) => {
    const parser = PARSERS.find((p) => p.id === id);
    if (!parser) throw new Error(`unknown parser "${id}" (known: ${parserIds().join(', ')})`);
    return parser;
  });
}
