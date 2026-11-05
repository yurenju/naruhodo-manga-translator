/**
 * 寄驗證碼信（spec #86「寄信」）：production 用 Resend；FAKE_MAIL 的 env（dev、test）用假的實作，不會真的寄，
 * 驗證碼記在記憶體的 outbox（DEV_OUTBOX_PATH 取得）並印在 wrangler dev 的終端機。
 */
export interface Mailer {
  sendCode(email: string, code: string): Promise<void>;
}

/** 假的寄信實作寄出的最後一組驗證碼：email → code。同一個 isolate 裡共用，wrangler dev 與 Worker 測試都只有一個。 */
const outbox = new Map<string, string>();

export const fakeMailer: Mailer = {
  async sendCode(email, code) {
    outbox.set(email, code);
    console.log(`[FAKE_MAIL] ${email} 的驗證碼：${code}`);
  },
};

export const lastSentCode = (email: string): string | undefined => outbox.get(email);

const RESEND_URL = 'https://api.resend.com/emails';

export function resendMailer({ apiKey, from }: { apiKey: string; from: string }): Mailer {
  return {
    async sendCode(email, code) {
      const response = await fetch(RESEND_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          from,
          to: [email],
          subject: `Naruhodo 登入驗證碼：${code}`,
          // 驗證碼單獨一行：後面緊接全形標點時，雙擊選取會連標點一起選到
          text: `你的 Naruhodo 登入驗證碼是：\n\n${code}\n\n10 分鐘內有效。如果你沒有要登入 Naruhodo，可以忽略這封信。`,
        }),
      });
      if (!response.ok) throw new Error(`Resend ${response.status}：${await response.text()}`);
    },
  };
}

export function mailer(env: Cloudflare.Env): Mailer {
  if (env.FAKE_MAIL === 'true') return fakeMailer;
  return resendMailer({ apiKey: env.RESEND_API_KEY ?? '', from: env.MAIL_FROM ?? '' });
}
