// Bundles web/app.js (with viem) and inlines it into web/index.template.html → swap.html
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'swap.html');

const result = await build({
  entryPoints: [join(here, 'app.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  platform: 'browser',
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace('__BUILD__', stamp);
const template = await readFile(join(here, 'index.template.html'), 'utf8');
if (!template.includes('<script>/*APP*/</script>')) throw new Error('template is missing the /*APP*/ placeholder');
await writeFile(out, template.replace('<script>/*APP*/</script>', () => `<script>${js}</script>`));
console.log(`wrote ${out} (${(js.length / 1024).toFixed(0)} KB of JS inlined, build ${stamp})`);
