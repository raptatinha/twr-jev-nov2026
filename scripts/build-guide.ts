/**
 * Builds guide/guide.html from guide/guide.md (one self-contained page, light and dark).
 *   npm run guide
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { marked } from 'marked';
import { faviconLink } from '../src/favicon';

// Markdown in, HTML body out (marked).
/**
 * Give every heading an id, so the table of contents can link to it.
 * Same rule as GitHub (lowercase, drop punctuation, each space becomes "-"), so the links in
 * guide.md also work when the file is viewed on GitHub.
 */
const slug = (text: string) => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-');
marked.use({
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
  },
});

const md = readFileSync('guide/guide.md', 'utf8');
const body = await marked.parse(md);

// The page styles: light by default, dark when the OS prefers it, or when data-theme="dark" is set.
const css = `
:root{color-scheme:light;--bg:#fafaf6;--fg:#1a0a2e;--muted:#483638;--line:#c8bfb8;--code:#f0ece4;--accent:#2d5f78}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--bg:#030214;--fg:#fbf7df;--muted:#e4dfd9;--line:#483638;--code:#1a0c2d;--accent:#7fb3cc}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#030214;--fg:#fbf7df;--muted:#e4dfd9;--line:#483638;--code:#1a0c2d;--accent:#7fb3cc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}h1{font-size:32px;line-height:1.2}h2{font-size:24px;margin-top:48px;border-top:1px solid var(--line);padding-top:24px}h3{font-size:19px;margin-top:28px}
a{color:var(--accent)}code{font:14px/1.5 ui-monospace,"SF Mono",Menlo,monospace;background:var(--code);padding:1px 5px;border-radius:4px}
h2,h3{scroll-margin-top:16px}.toc{columns:2;column-gap:32px}.toc ul{margin:0;padding-left:20px}.toc li{break-inside:avoid}@media (max-width:640px){.toc{columns:1}}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto}pre code{padding:0;background:none}
table{border-collapse:collapse;width:100%;font-size:14px;display:block;overflow-x:auto}th,td{border-bottom:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
hr{border:none;border-top:1px solid var(--line);margin:24px 0}li{margin:4px 0}
blockquote{margin:20px 0;padding:12px 18px;border-left:4px solid var(--accent);background:var(--code);border-radius:0 8px 8px 0}blockquote p{margin:0}
`;

// One self-contained page: styles inline, favicon inlined, the converted Markdown in <main>.
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jev training guide</title>${faviconLink()}<style>${css}</style></head>
<body><main>
<!-- Generated from guide/guide.md by \`npm run guide\`. Edit the Markdown, not this file. -->
${body}
</main></body></html>
`;
writeFileSync('guide/guide.html', html);
console.log('Wrote guide/guide.html');
