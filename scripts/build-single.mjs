#!/usr/bin/env node
// Bundles the app and its data into one self-contained file: dist/sportstat.html.
// Open that file directly, email it, or host it anywhere.
//   node scripts/build-single.mjs [--fragment] [outfile]
// --fragment leaves out the <html>/<head>/<body> wrapper for hosts that add their own.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fragment = args.includes('--fragment');
const out = args.find((a) => !a.startsWith('--')) || join(ROOT, 'dist', 'sportstat.html');
const read = (f) => readFile(join(ROOT, f), 'utf8');
const script = async (f) => `<script>${(await read(f)).replace(/<\/(script)/gi, '<\\/$1')}</script>`;

const head = `<meta name="claude:viewport-fit-sides" content="cover">
<title>Sport Stat</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@500;600;700&display=swap">
<style>${await read('styles.css')}</style>`;
const body = `<div class="wrap" id="app"></div>
${(await Promise.all(['data/nba.js', 'data/nfl.js', 'data/epl.js', 'model.js', 'app.js'].map(script))).join('\n')}`;
const html = fragment
  ? `${head}\n${body}\n`
  : `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
await mkdir(dirname(out), { recursive: true });
await writeFile(out, html);
console.log(`wrote ${out} (${(html.length / 1e6).toFixed(2)} MB)`);
