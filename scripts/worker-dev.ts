/**
 * `npm run worker:dev`：本機跑 Hosted Translation 的 Worker（env.dev），打真的 Anthropic 與 Paddle sandbox（#175）。
 * 由 scripts/with-op.ts 在 op run 底下啟動：Claude key 從 1Password 進到 NARUHODO_ANTHROPIC_KEY，這裡改名成
 * Worker 要的 CLAUDE_API_KEY 放進 wrangler 子行程的 env（wrangler.jsonc 的 env.dev 宣告了 secrets.required），不寫進檔案。
 * Paddle 的三個值由 --env-file 直接讀 ~/.config/naruhodo/paddle-sandbox.env（scripts/paddle-sandbox-wizard.sh 寫的）。
 * --env-file 指向不存在的檔案時 wrangler 會直接失敗，所以沒有那個檔案就不給；這時 wrangler 只要看到 worker/.dev.vars
 * 就只讀它、不看 env，key 會進不去，所以要求先刪掉它。
 * 其他參數原樣交給 wrangler dev，例如 `npm run worker:dev -- --port 8788`。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTestApiKey, TEST_API_KEY_ENV } from '../src/testing/test-api-key.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = join(root, 'worker', 'wrangler.jsonc');
const PADDLE_SANDBOX_ENV = join(homedir(), '.config', 'naruhodo', 'paddle-sandbox.env');

const apiKey = readTestApiKey();
if (!apiKey) {
  console.error(`沒有 ${TEST_API_KEY_ENV}：用 npm run worker:dev 啟動（經過 op run 從 1Password 取得 key）`);
  process.exit(1);
}
const DEV_VARS = join(root, 'worker', '.dev.vars');
let envFile: string[] = ['--env-file', PADDLE_SANDBOX_ENV];
if (!existsSync(PADDLE_SANDBOX_ENV)) {
  if (existsSync(DEV_VARS)) {
    console.error(`${DEV_VARS} 會蓋掉從 1Password 來的 key：刪掉它（Paddle 的值改放 ${PADDLE_SANDBOX_ENV}）`);
    process.exit(1);
  }
  console.warn(`沒有 ${PADDLE_SANDBOX_ENV}：Paddle 相關端點不能用（scripts/paddle-sandbox-wizard.sh 會建立它）`);
  envFile = [];
}
const args = [WRANGLER, 'dev', '-c', CONFIG, '--env', 'dev', ...envFile, ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, CLAUDE_API_KEY: apiKey } });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
