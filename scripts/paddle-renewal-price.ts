/**
 * 把舊訂閱（年繳 US$20 的 price）的下次續約換成新的年繳 US$48 price（ADR 0012）。一次性的開發者腳本。
 *
 * 換法：PATCH /subscriptions/{id}，items 換成新 price、proration_billing_mode: do_not_bill。
 * 這次不收錢、扣款週期不變，下次續約才照新價格扣。每筆先呼叫 Paddle 的 preview 試算，
 * 試算顯示會馬上扣款、下次扣款日會變、或訂閱不只一個 item，就略過不改。
 * 只動「目前用舊 price、沒被取消」的訂閱，所以重跑是安全的（已經換過的不會再列出來）。
 *
 * 預設是 dry run：只列出會改哪些訂閱與試算結果。加 --apply 才真的改。
 *
 * ── sandbox ──
 *   node scripts/paddle-renewal-price.ts            讀 ~/.config/naruhodo/paddle-sandbox.env
 *   node scripts/paddle-renewal-price.ts --apply    （--env <file> 換設定檔；--only <sub_…> 只處理一筆）
 *   用到 PADDLE_API_BASE_URL、PADDLE_API_KEY、PADDLE_PRICE_ID（舊價格）、PADDLE_PRICE_ID_YEARLY。
 *
 * ── production（開發者自己跑；這台機器上的 agent 不跑）──
 *   --production 不讀任何檔案，打 https://api.paddle.com，值全部從環境變數拿：
 *   1. API key：Worker 的 PADDLE_API_KEY 存在 Cloudflare、讀不回來。到 Paddle 後台（live）
 *      Developer tools → Authentication 建一把只給 subscription.read、subscription.write 的 key，
 *      設短一點的到期日，跑完就 revoke。key 開頭必須是 pdl_live_apikey_。
 *   2. PADDLE_PRICE_ID：舊的年繳 US$20 price（Paddle 後台 Catalog → 產品 → Prices）。
 *      PADDLE_PRICE_ID_YEARLY：新的年繳 US$48 price，要跟 Worker 的同名 secret 一樣。
 *   3. 在 Git Bash 裡（key 不寫進檔案、不留在 shell history）：
 *        read -rsp 'PADDLE_API_KEY: ' PADDLE_API_KEY; echo; export PADDLE_API_KEY
 *        export PADDLE_PRICE_ID=pri_… PADDLE_PRICE_ID_YEARLY=pri_…
 *        node scripts/paddle-renewal-price.ts --production
 *   4. 確認 dry run：列出的筆數就是舊訂閱者的人數；每筆「下次扣款」跟 Paddle 後台一樣；
 *      「下次金額」是新價格（48.00 USD，tax_mode 是 location 時某些地區會再加稅）。沒有任何 skipped。
 *      要在最早一筆的下次扣款日之前跑完，否則那筆會照舊價格續約。
 *   5. 沒問題再加 --apply（想先試一筆就加 --only <sub_…>）。跑完到 Paddle 後台看每筆訂閱：下次付款是新金額、日期沒變、沒有多出新的交易。
 *      再跑一次 dry run 應該列不出任何訂閱。最後 revoke 那把 key。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnvFile } from './env-file.ts';
import { PADDLE_SANDBOX_ENV_FILE } from './paddle-tunnel.ts';

const LIVE_API = 'https://api.paddle.com';
const KEY_PREFIX = { production: 'pdl_live_apikey_', sandbox: 'pdl_sdbx_apikey_' };

export interface RenewalPriceConfig {
  apiBaseUrl: string;
  apiKey: string;
  /** 舊的年繳 US$20 price。只動目前用這個 price 的訂閱。 */
  oldPriceId: string;
  /** 新的年繳 US$48 price（Worker 的 PADDLE_PRICE_ID_YEARLY）。 */
  newPriceId: string;
}

/**
 * sandbox 讀 wizard 寫的設定檔；production 不讀檔，全部從環境變數拿（key 不落地）。
 * key 的前綴要跟環境對得上，避免拿 live key 打 sandbox 的設定，或反過來。
 */
export function renewalPriceConfig({
  production,
  file,
  env,
}: {
  production: boolean;
  file: Record<string, string> | undefined;
  env: Record<string, string | undefined>;
}): RenewalPriceConfig {
  const source = production ? env : { ...file, ...env };
  const value = (key: string): string => {
    const found = source[key];
    if (!found) throw new Error(`缺少 ${key}${production ? '（環境變數）' : `（${PADDLE_SANDBOX_ENV_FILE} 或環境變數）`}`);
    return found;
  };
  const apiKey = value('PADDLE_API_KEY');
  const prefix = KEY_PREFIX[production ? 'production' : 'sandbox'];
  if (!apiKey.startsWith(prefix)) throw new Error(`PADDLE_API_KEY 應該是 ${prefix} 開頭（${production ? 'production' : 'sandbox'}）`);
  return {
    apiBaseUrl: production ? LIVE_API : value('PADDLE_API_BASE_URL'),
    apiKey,
    oldPriceId: value('PADDLE_PRICE_ID'),
    newPriceId: value('PADDLE_PRICE_ID_YEARLY'),
  };
}

export interface RenewalPriceResult {
  subscriptionId: string;
  outcome: 'would-change' | 'changed' | 'skipped';
  /** skipped 的原因。 */
  reason?: string;
  nextBilledAt: string | null;
  /** 換價格之後下次扣款的金額，Paddle 試算的（例如 "48.00 USD"，含 Paddle 依地區加的稅）。 */
  nextTotal: string;
}

interface PaddleSubscription {
  id: string;
  status: string;
  next_billed_at: string | null;
  items: { price: { id: string } }[];
}

interface PaddleResponse<T> {
  data: T;
  meta?: { pagination?: { next: string; has_more: boolean } };
}

interface PaddlePreview extends PaddleSubscription {
  immediate_transaction: unknown;
  next_transaction: { details: { totals: { total: string; currency_code: string } } } | null;
}

export async function switchRenewalPrice(
  config: RenewalPriceConfig,
  {
    apply,
    only,
    fetch = globalThis.fetch,
  }: {
    apply: boolean;
    /** 只處理這一筆訂閱（先試一筆時用）。 */
    only?: string;
    fetch?: typeof globalThis.fetch;
  },
): Promise<RenewalPriceResult[]> {
  const paddle = async <T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<PaddleResponse<T>> => {
    const response = await fetch(url.startsWith('https://') ? url : `${config.apiBaseUrl}${url}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) throw new Error(`Paddle ${init.method ?? 'GET'} ${url}：HTTP ${response.status} ${await response.text()}`);
    return (await response.json()) as PaddleResponse<T>;
  };

  const listSubscriptions = async (): Promise<PaddleSubscription[]> => {
    const all: PaddleSubscription[] = [];
    let url: string | undefined = '/subscriptions?per_page=200';
    while (url) {
      const page: PaddleResponse<PaddleSubscription[]> = await paddle<PaddleSubscription[]>(url);
      all.push(...page.data);
      url = page.meta?.pagination?.has_more ? page.meta.pagination.next : undefined;
    }
    return all;
  };

  const results: RenewalPriceResult[] = [];
  for (const subscription of await listSubscriptions()) {
    if (subscription.status === 'canceled') continue;
    if (only && subscription.id !== only) continue;
    if (!subscription.items.some((item) => item.price.id === config.oldPriceId)) continue;
    const base = { subscriptionId: subscription.id, nextBilledAt: subscription.next_billed_at, nextTotal: '' };
    if (subscription.items.length !== 1) {
      results.push({ ...base, outcome: 'skipped', reason: `有 ${subscription.items.length} 個 item，換價格會把其他 item 一起拿掉` });
      continue;
    }
    const change = { items: [{ price_id: config.newPriceId, quantity: 1 }], proration_billing_mode: 'do_not_bill' };
    const { data: preview } = await paddle<PaddlePreview>(`/subscriptions/${subscription.id}/preview`, { method: 'PATCH', body: change });
    const totals = preview.next_transaction?.details.totals;
    const nextTotal = totals ? `${(Number(totals.total) / 100).toFixed(2)} ${totals.currency_code}` : '（沒有下次扣款）';
    if (preview.immediate_transaction) {
      results.push({ ...base, nextTotal, outcome: 'skipped', reason: '試算顯示換價格會馬上扣款' });
      continue;
    }
    if (preview.next_billed_at !== subscription.next_billed_at) {
      results.push({ ...base, nextTotal, outcome: 'skipped', reason: `試算顯示下次扣款日會變成 ${preview.next_billed_at}` });
      continue;
    }
    const updated = apply
      ? (await paddle<PaddleSubscription>(`/subscriptions/${subscription.id}`, { method: 'PATCH', body: change })).data
      : preview;
    results.push({
      subscriptionId: subscription.id,
      outcome: apply ? 'changed' : 'would-change',
      nextBilledAt: updated.next_billed_at,
      nextTotal,
    });
  }
  return results;
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const OUTCOME_LABEL: Record<RenewalPriceResult['outcome'], string> = {
  'would-change': '會改（dry run）',
  changed: '✓ 已改',
  skipped: '✗ 略過',
};

async function main(): Promise<void> {
  const production = process.argv.includes('--production');
  const apply = process.argv.includes('--apply');
  const file = production ? undefined : parseEnvFile(readFileSync(option('--env') ?? PADDLE_SANDBOX_ENV_FILE, 'utf8'));
  const config = renewalPriceConfig({ production, file, env: process.env });
  console.log(`${production ? 'production' : 'sandbox'}：${config.apiBaseUrl}`);
  console.log(`舊 price ${config.oldPriceId} → 新 price ${config.newPriceId}${apply ? '' : '（dry run，加 --apply 才會改）'}`);

  const results = await switchRenewalPrice(config, { apply, only: option('--only') });
  for (const r of results) {
    const reason = r.reason ? `  ${r.reason}` : '';
    console.log(`${OUTCOME_LABEL[r.outcome]}  ${r.subscriptionId}  下次扣款 ${r.nextBilledAt}  下次金額 ${r.nextTotal || '—'}${reason}`);
  }
  console.log(results.length === 0 ? '沒有還在用舊 price 的訂閱。' : `共 ${results.length} 筆。`);
  if (results.some((r) => r.outcome === 'skipped')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
