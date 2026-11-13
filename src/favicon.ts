/**
 * The site icon for the HTML pages this project writes (dashboard, before/after report).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The testingwithrenata.com favicon (assets/favicon.png) as a <link> tag, inlined so pages work offline. */
export function faviconLink(): string {
  // Paths are relative to where you run npm (the repo root), not to this file.
  const file = join(process.cwd(), 'assets', 'favicon.png');
  // No icon file: return nothing, the page still works without it.
  if (!existsSync(file)) return '';
  // Embed the image as base64 inside the tag, so the HTML file is self-contained.
  return `<link rel="icon" type="image/png" href="data:image/png;base64,${readFileSync(file).toString('base64')}">`;
}
