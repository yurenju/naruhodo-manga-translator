/**
 * `npm run smoke:paddle`（#94、#262）：唯一碰真的 Paddle sandbox 的測試，不列進 `npm run test:browser`。Paddle 相關的改動之後再跑。
 * 本機起三樣東西（兩條測試共用）：Worker（wrangler dev --env dev，Paddle 的 key 由 ~/.config/naruhodo/paddle-sandbox.env 給）、
 * cloudflared quick tunnel（scripts/paddle-tunnel.ts，把 sandbox 的 webhook destination 改成這次的網址）、產品網站（astro dev，checkout 頁）。
 * 兩條都從登入 → side panel 的「查看方案」打開帳號頁 → 選一種 Billing Period → checkout 頁的 Paddle overlay 用 sandbox 測試卡付款 → 等 webhook 開始：
 * - 季繳：帳號頁是季繳訂閱（扣款週期、下次續訂 US$15）→ transaction.completed 讓退款區塊出現 → 申請退款 →
 *   Paddle 核准（sandbox 約 8 分鐘，adjustment.updated）→ Worker 取消訂閱 → 帳號頁「✓ 已退款」、回到免費方案，Paddle 上那筆訂閱是 canceled。
 * - 年繳：side panel 顯示本月額度 → 帳號頁刪除帳號（#95、#213）→ 回到未登入，Paddle 上那筆訂閱變成排定取消（scheduled_change.action = cancel）。
 * 用真的 checkout（不用 Simulations API）：要驗的就是 custom_data 帶 Account id → webhook → Worker 狀態這一段。
 * Paddle 的付款畫面如果出現 CAPTCHA 或其他真人驗證，測試不代解，直接失敗並說明卡在哪一步。
 * 不需要 Claude key：OCR 用 FakeEngine，登入後的翻譯會失敗，這裡不看翻譯。
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
/** sandbox 建立退款後要等一段時間（#261 實測約 8 分鐘）才送 adjustment.updated（approved）。 */
const REFUND_APPROVAL_TIMEOUT_MS = 15 * 60_000;

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

// Worker、tunnel、產品網站兩條測試共用：每條各起一次的話，tunnel 每次都要改 sandbox 的 webhook destination
const children: ChildProcess[] = [];
let stopWorker: (() => Promise<void>) | undefined;
let tempDir: string | undefined;

test.beforeAll(async () => {
  if (!sandbox) return;
  test.setTimeout(240_000);
  tempDir = await mkdtemp(join(tmpdir(), 'naruhodo-paddle-smoke-'));
  // Worker 只拿它要的五個值（.dev.vars 格式）
  const envFile = join(tempDir, '.dev.vars');
  const keys = ['PADDLE_API_KEY', 'PADDLE_API_BASE_URL', 'PADDLE_PRICE_ID_QUARTERLY', 'PADDLE_PRICE_ID_YEARLY', 'PADDLE_WEBHOOK_SECRET'];
  await writeFile(envFile, keys.map((k) => `${k}=${sandbox[k] ?? ''}`).join('\n') + '\n', { mode: 0o600 });
  stopWorker = await startWorker({ env: 'dev', envFile });

  // tunnel 轉到 e2e build 連的 Worker（8788），並把 sandbox 的 webhook destination 改成這次的網址
  children.push(
    await startProcess(process.execPath, ['scripts/paddle-tunnel.ts', '--port', '8788'], {}, (out) => out.includes('webhook destination →'), 90_000),
  );
  children.push(
    await startProcess(
      process.execPath,
      [join(root, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'dev', '--root', 'site', '--port', '4321'],
      { PUBLIC_PADDLE_CLIENT_TOKEN: sandbox.PADDLE_CLIENT_TOKEN, PUBLIC_PADDLE_ENVIRONMENT: sandbox.PADDLE_ENVIRONMENT ?? 'sandbox' },
      () => reachable(`${SITE_URL}/zh-tw/checkout`),
      60_000,
    ),
  );
});

test.afterAll(async () => {
  for (const child of children.splice(0)) kill(child);
  await stopWorker?.();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

/** Paddle 的付款畫面出現真人驗證就停下來（不代解）。 */
async function failOnHumanCheck(page: Page, step: string): Promise<void> {
  const challenge = page.frameLocator('iframe[src*="captcha"], iframe[src*="challenges.cloudflare.com"], iframe[title*="challenge" i]');
  if ((await challenge.locator('body').count()) > 0) throw new Error(`Paddle 在「${step}」出現真人驗證（CAPTCHA），需要開發者介入`);
}

/**
 * 在 checkout 頁的 Paddle overlay 填資料並用測試卡付款。付款完成後 checkout 頁顯示完成畫面（site/src/copy.ts）；
 * webhook 很快的話 SW 先查到訂閱中、直接把付款分頁關掉，所以兩種都算付完。
 */
async function payWithTestCard(checkout: Page, email: string): Promise<void> {
  const closed = checkout.waitForEvent('close', { timeout: 0 }).catch(() => undefined);
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
  await Promise.race([checkout.getByText('這個分頁可以關掉了').waitFor({ timeout: 60_000 }), closed]);
}

/** 直接問 Paddle sandbox API（只讀）：GET path 的 data。 */
async function paddleGet<T>(path: string): Promise<T> {
  const response = await fetch(`${sandbox!.PADDLE_API_BASE_URL}${path}`, { headers: { authorization: `Bearer ${sandbox!.PADDLE_API_KEY}` } });
  if (!response.ok) throw new Error(`Paddle API GET ${path} 失敗：HTTP ${response.status}`);
  return ((await response.json()) as { data: T }).data;
}

/** 付款分頁網址的 transaction 屬於哪一筆 Paddle 訂閱。 */
async function subscriptionOf(transactionId: string): Promise<string> {
  const { subscription_id: subscriptionId } = await paddleGet<{ subscription_id: string | null }>(`/transactions/${transactionId}`);
  expect(subscriptionId).toBeTruthy();
  return subscriptionId!;
}

/** 登入一個新帳號（先用免費額度）。登入後畫面上的頁會送去翻譯，env.dev 沒有 Anthropic 的 key，翻譯會失敗；這條不看翻譯。 */
async function signIn(panel: Page, context: BrowserContext, email: string): Promise<void> {
  await openSettings(panel);
  const settings = panel.getByRole('region', { name: '設定' });
  await selectTranslationMode(panel, '內建翻譯');
  await signInFromPanel(context, () => settings.getByRole('button', { name: '登入' }).click(), email);
  await panel.getByRole('button', { name: '返回' }).click();
}

/** Playwright 不會送 focus 事件：頁面在重新取得焦點時重讀額度，由測試代送。 */
const refocus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

/** 一直代送 focus，直到 visible() 成立（webhook 經過 tunnel 到 Worker、Worker 狀態變了才會成立）。 */
async function untilVisible(page: Page, visible: () => Promise<boolean>, timeout: number, interval = 3000): Promise<void> {
  await expect
    .poll(
      async () => {
        await refocus(page);
        return visible();
      },
      { timeout, intervals: [interval] },
    )
    .toBe(true);
}

/**
 * 登入新帳號 → side panel 的「查看方案」打開帳號頁 → 選 button 的扣款週期 → 用測試卡付款。
 * 回傳帳號頁、side panel、付款的 transaction id。
 */
async function subscribe(
  fixtures: Parameters<typeof activateOnMockSite>[0],
  button: '訂閱季繳' | '訂閱年繳',
): Promise<{ account: Page; panel: Page; transactionId: string }> {
  const { context } = fixtures;
  const { panel } = await activateOnMockSite(fixtures);
  const email = `smoke-paddle-${Date.now()}@example.com`;
  await signIn(panel, context, email);
  const remaining = panel.getByRole('status', { name: '剩餘額度' });
  await expect(remaining).toHaveText(/免費額度剩 \d+ 頁/);

  const accountOpened = context.waitForEvent('page');
  await remaining.getByRole('button', { name: '查看方案' }).click();
  const account = await accountOpened;

  const checkoutOpened = context.waitForEvent('page');
  await account.getByRole('region', { name: '訂閱' }).getByRole('button', { name: button }).click();
  const checkout = await checkoutOpened;
  await checkout.waitForURL(/\/zh-tw\/checkout\?_ptxn=txn_/);
  const transactionId = new URL(checkout.url()).searchParams.get('_ptxn')!;
  await payWithTestCard(checkout, email);
  return { account, panel, transactionId };
}

test('Paddle sandbox 季繳：帳號頁選季繳 → 測試卡付款 → 帳號頁是季繳訂閱 → 申請退款 → Paddle 核准 → 訂閱取消、回到免費方案', async ({
  context,
  sw,
  extensionId,
  mockSite,
}) => {
  test.setTimeout(REFUND_APPROVAL_TIMEOUT_MS + 300_000);
  const { account, transactionId } = await subscribe({ context, sw, extensionId, mockSite }, '訂閱季繳');

  // subscription.created 經過 tunnel 到 Worker 通常幾秒；SW 查到訂閱中就關掉付款分頁、切回帳號頁
  await expect(account.getByRole('status').filter({ hasText: '✓ 訂閱完成' })).toContainText('季繳，每月可翻 3,000 頁。', { timeout: 90_000 });
  const plan = account.getByRole('region', { name: '目前方案' });
  await expect(plan).toContainText('扣款週期季繳');
  await expect(plan).toContainText(/下次續訂\d{4} 年 \d+ 月 \d+ 日・US\$15/);

  // 退款區塊要等 Worker 記下 transaction.completed 的扣款
  const refundButton = plan.getByRole('button', { name: '申請退款' });
  await untilVisible(account, () => refundButton.isVisible(), 90_000);
  await expect(plan.getByRole('group', { name: '退款' })).toContainText('扣款後 14 天內可以申請全額退款');

  await refundButton.click();
  // price 是 tax_mode internal（標價含稅，ADR 0012）：退的就是標價，不會多出稅
  const dialog = account.getByRole('dialog', { name: /^退款 US\$15(\.00)?，並結束訂閱？$/ });
  console.log('退款對話框：', await dialog.getByRole('heading').innerText());
  await dialog.getByRole('button', { name: '確定退款' }).click();
  await expect(plan.getByRole('status', { name: '退款處理中' })).toBeVisible({ timeout: 30_000 });
  // 處理中：照常是訂閱中，管理訂閱還在
  await expect(plan.getByRole('button', { name: '管理訂閱（付款方式、取消）' })).toBeVisible();
  const requestedAt = Date.now();

  // Paddle 核准 → adjustment webhook → Worker 立即取消訂閱 → subscription.canceled → 帳號回到免費方案
  const refunded = account.getByRole('status').filter({ hasText: '✓ 已退款' });
  await untilVisible(account, () => refunded.isVisible(), REFUND_APPROVAL_TIMEOUT_MS, 10_000);
  console.log(`退款核准：申請後 ${Math.round((Date.now() - requestedAt) / 1000)} 秒`);
  await expect(plan.locator('.ac-plan-name')).toHaveText('免費');
  await expect(account.getByRole('region', { name: '訂閱' })).toBeVisible();

  const subscription = await paddleGet<{ status: string }>(`/subscriptions/${await subscriptionOf(transactionId)}`);
  expect(subscription.status).toBe('canceled');
  console.log('Paddle 訂閱：', subscription.status);
});

test('Paddle sandbox 年繳：帳號頁選年繳 → 測試卡付款 → side panel 顯示本月額度 → 刪除帳號取消訂閱', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(300_000);
  const { account, panel, transactionId } = await subscribe({ context, sw, extensionId, mockSite }, '訂閱年繳');

  // side panel 在重新取得焦點時重讀
  const remaining = panel.getByRole('status', { name: '剩餘額度' });
  await untilVisible(panel, async () => /^本月剩 3,000 頁・\d+ 月 \d+ 日重置$/.test(await remaining.innerText()), 90_000);
  console.log('side panel：', await remaining.innerText());
  await expect(account.getByRole('region', { name: '目前方案' })).toContainText('扣款週期年繳');

  // 刪除帳號（#95）：Worker 先對 Paddle 取消訂閱，再刪資料；帳號頁回到未登入
  const deleteSection = account.getByRole('region', { name: '刪除帳號' });
  await deleteSection.getByRole('button', { name: '刪除帳號' }).click();
  await deleteSection.getByRole('button', { name: '刪除帳號' }).click();
  await expect(account.getByRole('button', { name: '登入' })).toBeVisible({ timeout: 30_000 });

  const subscription = await paddleGet<{ status: string; scheduled_change: { action: string } | null }>(`/subscriptions/${await subscriptionOf(transactionId)}`);
  // 到期才失效：仍然 active，排定在這一年結束時取消
  expect(subscription).toMatchObject({ status: 'active', scheduled_change: { action: 'cancel' } });
  console.log('Paddle 訂閱：', subscription.status, subscription.scheduled_change);
});
