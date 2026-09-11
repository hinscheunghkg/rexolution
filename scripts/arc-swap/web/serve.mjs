// Tiny static server so swap.html runs on http://localhost (wallet extensions
// always inject there, unlike file:// pages). Run: npm run web
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 8787);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const path = req.url.split('?')[0] === '/' ? '/swap.html' : req.url.split('?')[0];
  try {
    const body = await readFile(join(root, path.replace(/\.\./g, '')));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Arc Swap is running. Open this in the browser that has your wallet:\n\n   http://localhost:${port}/\n\nPress Ctrl+C to stop.`);
});
