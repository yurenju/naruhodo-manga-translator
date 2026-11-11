/**
 * 讀 Paddle webhook 事件的共用工具：subscription.*（subscription.ts）、transaction 與 adjustment（charges.ts）都用。
 * 事件是外部送來的 JSON，欄位的型別不能假設，這裡的函式讀不到就回 undefined／空物件。
 */

/** ISO 時間字串轉成 Unix 毫秒；不是合法的時間就是 undefined。 */
export const time = (value: unknown): number | undefined => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
};

export const object = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/** 非空字串；其他都是 undefined。 */
export const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** 這個事件處理過了沒（paddle_events 用 event_id 去重：Paddle 重送的事件只套用一次）。 */
export async function eventHandled(db: D1Database, eventId: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 FROM paddle_events WHERE event_id = ?').bind(eventId).first()) !== null;
}

/** 記下處理過的事件；跟套用事件的寫入放在同一個 batch。 */
export const markEventHandled = (db: D1Database, eventId: string, now: number): D1PreparedStatement =>
  db.prepare('INSERT INTO paddle_events (event_id, received_at) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(eventId, now);

/**
 * 事件屬於哪個 Account：custom_data.account_id（Worker 建立 transaction 時放的，Paddle 帶到 subscription 上）要是存在的 Account；
 * 沒有的話（續約的 transaction 不帶 custom_data）用 subscription id 找已經存在的訂閱。
 * 刪除帳號會一起刪掉訂閱那一列，所以刪除後才送來的事件兩邊都找不到，不會套用。
 */
export async function eventOwner(db: D1Database, fromCustomData: string | undefined, subscriptionId: string): Promise<string | undefined> {
  if (fromCustomData) {
    const account = await db.prepare('SELECT id FROM accounts WHERE id = ?').bind(fromCustomData).first<{ id: string }>();
    if (account) return account.id;
  }
  const row = await db.prepare('SELECT account_id FROM subscriptions WHERE paddle_subscription_id = ?').bind(subscriptionId).first<{ account_id: string }>();
  return row?.account_id;
}
