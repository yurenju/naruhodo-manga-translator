/**
 * `npm run site:build` 產生的 site/dist 的靜態 server（跟正式部署一樣，目錄的網址回傳裡面的 index.html）。
 * 首頁展示（site-demo.spec.ts）與錄 Practice Spread 的 OCR（record-practice-spread.spec.ts）用。
 */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname } from 'node:path';

const DIST = new URL('../site/dist/', import.meta.url);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export interface SiteServer {
  origin: string;
  close(): Promise<void>;
}

export async function startSiteServer(): Promise<SiteServer> {
  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://site').pathname.replace(/\/$/, '/index.html').slice(1);
    try {
      const body = await readFile(new URL(decodeURIComponent(path), DIST));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      // close 會等所有連線結束：瀏覽器留著的 keep-alive 或還沒回完的請求會讓 teardown 卡到逾時（PR #116 的 CI）
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
