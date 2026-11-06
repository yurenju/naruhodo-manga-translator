/**
 * worker/wrangler.jsonc 最上層（production）的 D1 database_id；還沒建立（"local" 或沒填）就是 undefined。
 * prod-proxy.ts 只查這個資料庫；兩個 wizard 用指令讀：
 *   node scripts/production-config.ts database-id    印出 database_id，還沒建立就什麼都不印
 */
import { pathToFileURL } from 'node:url';
import { experimental_readRawConfig } from 'wrangler';

export const WORKER_CONFIG = 'worker/wrangler.jsonc';

export function productionDatabaseId(config = WORKER_CONFIG): string | undefined {
  const { rawConfig } = experimental_readRawConfig({ config });
  const id = rawConfig.d1_databases?.[0]?.database_id;
  return id && /^[0-9a-f-]{36}$/.test(id) ? id : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'database-id') {
    console.error('用法：node scripts/production-config.ts database-id');
    process.exit(2);
  }
  process.stdout.write(productionDatabaseId() ?? '');
}
