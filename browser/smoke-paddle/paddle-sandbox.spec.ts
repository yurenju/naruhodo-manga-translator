/**
 * `npm run smoke:paddle`（#94）：唯一碰真的 Paddle sandbox 的測試，不列進 `npm run test:browser`。Paddle 相關的改動之後再跑。
 * 本機起三樣東西：Worker（wrangler dev --env dev，Paddle 的 key 由 ~/.config/naruhodo/paddle-sandbox.env 給）、
 * cloudflared quick tunnel（scripts/paddle-tunnel.ts，把 sandbox 的 webhook destination 改成這次的網址）、產品網站（astro dev，checkout 頁）。
 * 流程：登入 → side panel 按「訂閱」→ checkout 頁的 Paddle overlay 用 sandbox 測試卡付款 → 等 webhook → side panel 顯示本月額度 →
 * 帳號與訂閱頁刪除帳號（#95、#213）→ 回到未登入，Paddle sandbox 上那筆訂閱變成排定取消（scheduled_change.action = cancel）。
 * 用真的 checkout（不用 Simulations API）：要驗的就是 custom_data 帶 Account id → webhook → Worker 狀態這一段。
 * Paddle 的付款畫面如果出現 CAPTCHA 或其他真人驗證，測試不代解，直接失敗並說明卡在哪一步。
 * 設定檔不存在時跳過。秘密只寫進只有這個測試用的暫存檔交給 wrangler，不印出。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, FrameLocator, Page } from '@playwright/test';
import { parseEnvFile } from '../../scripts/env-file.ts';
import { activateOnMockSite, expect, openSettings, selectTranslationMode, test } from '../fixtures.ts';
import { signInFromPanel } from '../sign-in.ts';
import { startWorker } from '../worker.ts';

const ENV_FILE = join(homedir(), '.config', 'naruhodo', 'paddle-sandbox.env');
const root = fileURLToPath(new URL('../..', import.meta.url));
const SITE_URL = 'http://localhost:4321';
/** Paddle 公開的 sandbox 測試卡（https://developer.paddle.com/concepts/payment-methods/credit-debit-card#test-payment-method）。 */
const TEST_CARD = { number: '4242 4242 4242 4242', name: 'Naruhodo Smoke', expiry: '12/30', cvv: '100' };

const sandbox = existsSync(ENV_FILE) ? parseEnvFile(readFileSync(ENV_FILE, 'utf8')) : undefined;
if (!sandbox) console.log(`已跳過：沒有 ${ENV_FILE}（先跑 bash scripts/paddle-sandbox-wizard.sh）`);
test.skip(!sandbox, '沒有 Paddle sandbox 設定檔');
test.use({ viewport: null, fakeOcr: true });

/** 關掉子行程（Windows 要連 wrangler／cloudflared 底下的子行程一起關）。 */
function kill(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill();
}

/** 啟動子行程，等 output 出現 ready（或 check 成功）；逾時就關掉並丟出最後的 output。 */
async function startProcess(command: string, args: string[], env: NodeJS.ProcessEnv, ready: (output: string) => boolean | Promise<boolean>, timeoutMs: number) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => (output += chunk));
  child.stderr!.on('data', (chunk: Buffer) => (output += chunk));
  const deadline = Date.now() + timeoutMs;
  while (!(await ready(output))) {
    if (child.exitCode !== null || Date.now() > deadline) {
      kill(child);
      throw new Error(`${args.join(' ')} 沒有啟動：\n${output.slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return child;
}

const reachable = async (url: string) => {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
};

/** Paddle 的付款畫面出現真人驗證就停下來（不代解）。 */
async function failOnHumanCheck(page: Page, step: string): Promise<void> {
  const challenge = page.frameLocator('iframe[src*="captcha"], iframe[src*="challenges.cloudflare.com"], iframe[title*="challenge" i]');
  if ((await challenge.locator('body').count()) > 0) throw new Error(`Paddle 在「${step}」出現真人驗證（CAPTCHA），需要開發者介入`);
}

/** 在 checkout 頁的 Paddle overlay 填資料並用測試卡付款。 */
async function payWithTestCard(checkout: Page, email: string): Promise<void> {
  const overlay: FrameLocator = checkout.frameLocator('iframe[name="paddle_frame"], iframe.paddle-frame');
  await overlay.getByTestId('authenticationEmailInput').fill(email, { timeout: 30_000 });
  await overlay.getByTestId('countriesSelect').selectOption('US');
  await overlay.getByTestId('postcodeInput').fill('10001');
  await overlay.getByTestId('combinedAuthenticationLocationFormSubmitButton').click();
  await failOnHumanCheck(checkout, '填 email 與地址');

  // 付款方式：有選單時先選信用卡
  const cardOption = overlay.getByTestId('cardPaymentSelectionButton');
  if (await cardOption.isVisible({ timeout: 10_000 }).catch(() => false)) await cardOption.click();
  await overlay.getByTestId('cardNumberInput').fill(TEST_CARD.number, { timeout: 30_000 });
  await overlay.getByTestId('cardholderNameInput').fill(TEST_CARD.name);
  await overlay.getByTestId('expiryDateField').fill(TEST_CARD.expiry);
  await overlay.getByTestId('cardVerificationValueInput').fill(TEST_CARD.cvv);
  await overlay.getByTestId('cardPaymentFormSubmitButton').click();
  await failOnHumanCheck(checkout, '送出信用卡');
  // checkout 頁收到 checkout.completed 後顯示完成畫面（site/src/copy.ts）
  await expect(checkout.getByText('這個分頁可以關掉了')).toBeVisible({ timeout: 60_000 });
}

/** 直接問 Paddle sandbox API（只讀）：GET path 的 data。 */
async function paddleGet<T>(env: Record<string, string>, path: string): Promise<T> {
  const response = await fetch(`${env.PADDLE_API_BASE_URL}${path}`, { headers: { authorization: `Bearer ${env.PADDLE_API_KEY}` } });
  if (!response.ok) throw new Error(`Paddle API GET ${path} 失敗：HTTP ${response.status}`);
  return ((await response.json()) as { data: T }).data;
}

/** 登入一個新帳號（先用免費額度）。登入後畫面上的頁會送去翻譯，env.dev 沒有 Anthropic 的 key，翻譯會失敗；這條不看翻譯。 */
async function signIn(panel: Page, context: BrowserContext, email: string): Promise<void> {
  await openSettings(panel);
  const settings = panel.getByRole('region', { name: '設定' });
  await selectTranslationMode(panel, '內建翻譯');
  await signInFromPanel(context, () => settings.getByRole('button', { name: '登入' }).click(), email);
  await panel.getByRole('button', { name: '返回' }).click();
}

test('Paddle sandbox：side panel 訂閱 → checkout overlay 用測試卡付款 → webhook → side panel 顯示本月額度 → 刪除帳號取消訂閱', async ({
  context,
  sw,
  extensionId,
  mockSite,
}) => {
  test.setTimeout(300_000);
  const env = sandbox!;
  const dir = await mkdtemp(join(tmpdir(), 'naruhodo-paddle-smoke-'));
  const children: ChildProcess[] = [];
  let stopWorker: (() => Promise<void>) | undefined;
  try {
    // Worker 只拿它要的五個值（.dev.vars 格式）
    const envFile = join(dir, '.dev.vars');
    const keys = ['PADDLE_API_KEY', 'PADDLE_API_BASE_URL', 'PADDLE_PRICE_ID_QUARTERLY', 'PADDLE_PRICE_ID_YEARLY', 'PADDLE_WEBHOOK_SECRET'];
    await writeFile(envFile, keys.map((k) => `${k}=${env[k] ?? ''}`).join('\n') + '\n', { mode: 0o600 });
    stopWorker = await startWorker({ env: 'dev', envFile });

    // tunnel 轉到 e2e build 連的 Worker（8788），並把 sandbox 的 webhook destination 改成這次的網址
    children.push(
      await startProcess(process.execPath, ['scripts/paddle-tunnel.ts', '--port', '8788'], {}, (out) => out.includes('webhook destination →'), 90_000),
    );
    children.push(
      await startProcess(
        process.execPath,
        [join(root, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'dev', '--root', 'site', '--port', '4321'],
        { PUBLIC_PADDLE_CLIENT_TOKEN: env.PADDLE_CLIENT_TOKEN, PUBLIC_PADDLE_ENVIRONMENT: env.PADDLE_ENVIRONMENT ?? 'sandbox' },
        () => reachable(`${SITE_URL}/zh-tw/checkout`),
        60_000,
      ),
    );

    const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite });
    const email = `smoke-paddle-${Date.now()}@example.com`;
    await signIn(panel, context, email);
    const remaining = panel.getByRole('status', { name: '剩餘額度' });
    await expect(remaining).toHaveText(/免費額度剩 \d+ 頁/);

    const opened = context.waitForEvent('page');
    await remaining.getByRole('button', { name: '訂閱' }).click();
    const checkout = await opened;
    await checkout.waitForURL(/\/zh-tw\/checkout\?_ptxn=txn_/);
    await payWithTestCard(checkout, email);

    // webhook 經過 tunnel 到 Worker 通常幾秒；side panel 在重新取得焦點時重讀（Playwright 不會送 focus 事件，由測試代送）
    await expect
      .poll(
        async () => {
          await panel.evaluate(() => window.dispatchEvent(new Event('focus')));
          return remaining.innerText();
        },
        { timeout: 90_000, intervals: [3000] },
      )
      .toMatch(/^本月剩 800 頁・\d+ 月 \d+ 日重置$/);
    console.log('side panel：', await remaining.innerText());

    // 刪除帳號（#95）：在帳號與訂閱頁（#213）；Worker 先對 Paddle 取消訂閱，再刪資料；帳號頁回到未登入
    const transactionId = new URL(checkout.url()).searchParams.get('_ptxn')!;
    const account = await context.newPage();
    await account.goto(`chrome-extension://${extensionId}/account.html`);
    await account.getByRole('region', { name: '刪除帳號' }).getByRole('button', { name: '刪除帳號' }).click();
    await account.getByRole('region', { name: '刪除帳號' }).getByRole('button', { name: '刪除帳號' }).click();
    await expect(account.getByRole('button', { name: '登入' })).toBeVisible({ timeout: 30_000 });

    const { subscription_id: subscriptionId } = await paddleGet<{ subscription_id: string | null }>(env, `/transactions/${transactionId}`);
    expect(subscriptionId).toBeTruthy();
    const subscription = await paddleGet<{ status: string; scheduled_change: { action: string } | null }>(env, `/subscriptions/${subscriptionId}`);
    // 到期才失效：仍然 active，排定在這一年結束時取消
    expect(subscription).toMatchObject({ status: 'active', scheduled_change: { action: 'cancel' } });
    console.log('Paddle 訂閱：', subscription.status, subscription.scheduled_change);
  } finally {
    for (const child of children) kill(child);
    await stopWorker?.();
    await rm(dir, { recursive: true, force: true });
  }
});
