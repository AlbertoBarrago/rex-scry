import { render } from 'ink';
import type { Workspace } from '../types.js';
import { App } from './App.js';
import type { Filter } from './model.js';

/**
 * Starts the panel in the terminal's alternate screen, so quitting gives the
 * scrollback back untouched. Loaded by `rex-diagnostics ui` only, through a
 * dynamic import: Ink and React never load for `run` or `list`.
 */
export async function runPanel(opts: { workspace: Workspace; stateDir: string; filter: Filter }): Promise<number> {
  const app = render(<App workspace={opts.workspace} stateDir={opts.stateDir} initialFilter={opts.filter} />, {
    alternateScreen: true,
  });
  await app.waitUntilExit();
  return 0;
}
