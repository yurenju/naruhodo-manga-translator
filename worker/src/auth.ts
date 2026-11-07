/**
 * Account 與 email 驗證碼登入（spec #86、#91）。D1 schema 在 worker/migrations/0001_accounts.sql。
 * OTP 與 session token 只存 SHA-256 hash；時間一律是 Unix 毫秒。
 */
import { sha256 } from './hash.ts';
import type { Mailer } from './mailer.ts';
import { grantFreePages } from './quota.ts';

/** 驗證碼 10 分鐘內有效。 */
const CODE_TTL_MS = 10 * 60 * 1000;

/** 同一組驗證碼錯到第 5 次就失效，要重新寄送。 */
const MAX_ATTEMPTS = 5;

/**
 * 同一個 email 在一小時內最多驗證 10 次，不管重新寄送幾次（重寄只讓「這一組」的 5 次重新算）。
 * 用完回 rateLimited，時間窗過了才能再試：6 位數的空間是一百萬，一天最多猜 240 次。
 * 代價是別人可以故意猜錯，讓這個 email 一小時內登不進來；寄送與驗證另外都有依 IP 的頻率限制。
 */
const MAX_ATTEMPTS_PER_WINDOW = 10;
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

/** session token 閒置超過 180 天才失效；每次使用都重新起算。 */
const SESSION_IDLE_MS = 180 * 24 * 60 * 60 * 1000;

/** 6 位數驗證碼的空間很小，hash 帶上 email，不同 email 的同一組數字 hash 不同。 */
const codeHash = (email: string, code: string) => sha256(`${email}:${code}`);

function randomCode(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String(n! % 1_000_000).padStart(6, '0');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * 寄出新的驗證碼；同一個 email 之前的那組作廢（這一組的嘗試次數歸零，一小時內的驗證次數不歸零）。
 * 順手刪掉所有已經過期的驗證碼（寄了沒用的 email 不會一直留在 D1；過期的本來就只會回 codeExpired，刪掉結果一樣），
 * 時間窗已經過了的驗證次數，以及已登出或閒置失效的 session（再也不會通過 authenticate，留著只是多存一份紀錄）。
 */
export async function sendCode(db: D1Database, mail: Mailer, email: string, now: number): Promise<void> {
  const code = randomCode();
  await db.batch([
    db.prepare('DELETE FROM otps WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM verify_attempts WHERE window_start <= ?').bind(now - ATTEMPT_WINDOW_MS),
    db.prepare('DELETE FROM sessions WHERE revoked_at IS NOT NULL OR last_used_at < ?').bind(now - SESSION_IDLE_MS),
    db
      .prepare(
        `INSERT INTO otps (email, code_hash, expires_at, attempts) VALUES (?1, ?2, ?3, 0)
         ON CONFLICT (email) DO UPDATE SET code_hash = ?2, expires_at = ?3, attempts = 0`,
      )
      .bind(email, await codeHash(email, code), now + CODE_TTL_MS),
  ]);
  await mail.sendCode(email, code);
}

export type VerifyResult = { ok: true; token: string } | { ok: false; reason: 'wrongCode' | 'codeExpired' | 'tooManyAttempts' | 'rateLimited' };

/**
 * 驗證碼正確：作廢這組驗證碼、第一次就建立 Account，發一個新的 session token。
 * 比對之前先用條件式 upsert 佔用一小時內的一次驗證（同時送來的猜測不會超過上限）；這一組的錯誤次數用條件式 UPDATE 累加，
 * 兩個同時送來的猜測不會都算成第 4 次。
 */
export async function verifyCode(db: D1Database, email: string, code: string, now: number): Promise<VerifyResult> {
  const otp = await db.prepare('SELECT code_hash, expires_at, attempts FROM otps WHERE email = ?').bind(email).first<{ code_hash: string; expires_at: number; attempts: number }>();
  if (!otp || otp.expires_at < now) return { ok: false, reason: 'codeExpired' };
  const emailHash = await sha256(email);
  const reserved = await db
    .prepare(
      `INSERT INTO verify_attempts (email_hash, window_start, attempts) VALUES (?1, ?2, 1)
       ON CONFLICT (email_hash) DO UPDATE SET
         attempts = CASE WHEN window_start <= ?3 THEN 1 ELSE attempts + 1 END,
         window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
       WHERE window_start <= ?3 OR attempts < ?4
       RETURNING attempts`,
    )
    .bind(emailHash, now, now - ATTEMPT_WINDOW_MS, MAX_ATTEMPTS_PER_WINDOW)
    .first();
  if (!reserved) return { ok: false, reason: 'rateLimited' };
  if (otp.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'tooManyAttempts' };
  if (otp.code_hash !== (await codeHash(email, code))) {
    const counted = await db
      .prepare('UPDATE otps SET attempts = attempts + 1 WHERE email = ? AND attempts < ? RETURNING attempts')
      .bind(email, MAX_ATTEMPTS)
      .first<{ attempts: number }>();
    return { ok: false, reason: !counted || counted.attempts >= MAX_ATTEMPTS ? 'tooManyAttempts' : 'wrongCode' };
  }
  // 刪得掉才算數：同一組驗證碼同時送兩次，只有一次登入
  const consumed = await db.prepare('DELETE FROM otps WHERE email = ? AND code_hash = ?').bind(email, otp.code_hash).run();
  if (consumed.meta.changes === 0) return { ok: false, reason: 'codeExpired' };
  await db.prepare('DELETE FROM verify_attempts WHERE email_hash = ?').bind(emailHash).run();
  const accountId = await ensureAccount(db, email, now);
  const token = randomToken();
  await db
    .prepare('INSERT INTO sessions (token_hash, account_id, created_at, last_used_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), accountId, now, now)
    .run();
  return { ok: true, token };
}

/** 第一次登入時建立 Account，並發放 Free Pages（這個 email 沒領過才有）。 */
async function ensureAccount(db: D1Database, email: string, now: number): Promise<string> {
  const id = crypto.randomUUID();
  const created = await db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING').bind(id, email, now).run();
  if (created.meta.changes === 1) {
    await grantFreePages(db, id, email, now);
    return id;
  }
  const row = await db.prepare('SELECT id FROM accounts WHERE email = ?').bind(email).first<{ id: string }>();
  return row!.id;
}

/** session token 對應的 Account id，順便延長期限；沒有這個 token、已撤銷或閒置太久就是 undefined。 */
export async function authenticate(db: D1Database, token: string, now: number): Promise<string | undefined> {
  const row = await db
    .prepare('UPDATE sessions SET last_used_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL AND last_used_at >= ?3 RETURNING account_id')
    .bind(now, await sha256(token), now - SESSION_IDLE_MS)
    .first<{ account_id: string }>();
  return row?.account_id;
}

/** 登出：只撤銷這一個 token，同一個 Account 在別台電腦的登入不受影響。 */
export async function revokeSession(db: D1Database, token: string, now: number): Promise<void> {
  await db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').bind(now, await sha256(token)).run();
}

/**
 * 刪除 Account（spec #86「Worker API」、#95）：Account、所有 session（所以每個 token 都失效）、額度、訂閱，
 * 以及這個 email 還沒用掉的驗證碼與驗證次數，一次刪掉。之後 D1 裡沒有這個 email 的原文。
 * 用量紀錄不刪、只拿掉帳號關聯（#238）：裡面只有數字，留著 D1 的總額才對得上 Anthropic 的帳單。
 * Free Pages 領取紀錄（email hash）不刪，同一個 email 重新註冊不會再領；paddle_events 只有事件 id，不屬於任何 Account。
 * 子資料表先處理，最後才刪 accounts（D1 會檢查 foreign key；otps 要靠 accounts 查出 email）。
 */
export async function deleteAccount(db: D1Database, accountId: string): Promise<void> {
  const email = await accountEmail(db, accountId);
  await db.batch([
    db.prepare('DELETE FROM verify_attempts WHERE email_hash = ?').bind(await sha256(email ?? '')),
    db.prepare('DELETE FROM otps WHERE email = (SELECT email FROM accounts WHERE id = ?)').bind(accountId),
    db.prepare('UPDATE usage_records SET account_id = NULL WHERE account_id = ?').bind(accountId),
    ...['sessions', 'quotas', 'subscriptions', 'accounts'].map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE ${table === 'accounts' ? 'id' : 'account_id'} = ?`).bind(accountId),
    ),
  ]);
}

export async function accountEmail(db: D1Database, accountId: string): Promise<string | undefined> {
  const row = await db.prepare('SELECT email FROM accounts WHERE id = ?').bind(accountId).first<{ email: string }>();
  return row?.email;
}
