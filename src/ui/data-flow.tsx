/**
 * 兩種翻譯模式的資料流向說明（#93）：讀者按「同意並寄送驗證碼」「同意並儲存」「同意並啟用翻譯」時同意的就是這些文字。
 * 內建翻譯：onboarding 第 2 步與設定的登入（SignIn）；自備金鑰：onboarding 的「使用自備金鑰」與 side panel 的資料使用說明卡。
 * 內容要跟 PRIVACY.md 一致，兩邊一起改。是不是 Material Change（要重新同意）照 ADR 0015 判斷：是的話把
 * shared/data-consent-version.ts 裡那個模式的 DATA_CONSENT_VERSION 加一、CONSENT_CHANGES 改寫成這次改了什麼（跟那個模式無關的升版寫 undefined）；
 * 不是的話（界線內的新數字、新設定、改寫文字）不升版，文字仍要涵蓋新的欄位。
 */
import { CONSENT_CHANGES } from '../shared/data-consent-version.ts';
import type { TranslationMode } from '../shared/translation-mode.ts';
import { PRIVACY_URL, TERMS_URL } from './links.ts';

const LOCAL = '對話框偵測與文字辨識都在這台電腦上進行，不會上傳圖片，也不會送出網址。';

export function HostedDataFlow() {
  return (
    <ul>
      <li>{LOCAL}</li>
      <li>辨識出的日文文字、同一部作品前幾頁的原文與譯文、作品的角色與用語、作品名稱，以及用來判斷是哪部作品的網頁標題，會傳到 Naruhodo 的服務，再交給 Anthropic 翻譯。Naruhodo 的服務不保存這些文字與作品名。</li>
      <li>Naruhodo 的服務會保存你的 email、登入紀錄、剩餘頁數、訂閱狀態，以及每次翻譯與猜作品名稱的用量（只有數字與外掛產生的隨機作品編號，不含內容，刪除帳號後匿名保留）；驗證碼信由 Resend 寄出。</li>
    </ul>
  );
}

export function OwnKeyDataFlow() {
  return (
    <ul>
      <li>{LOCAL}</li>
      <li>辨識出的日文文字、前幾頁的原文與譯文、作品的角色與用語、作品名稱，以及用來判斷是哪部作品的網頁標題，會用你的 API key 直接傳到 Anthropic 翻譯，不經過 Naruhodo 的服務。</li>
      <li>API key 只存在這台電腦的外掛裡。</li>
    </ul>
  );
}

/**
 * 補同意的說明（Data Use Consent）：side panel 的說明卡與 onboarding 的補同意畫面共用。
 * updated＝同意過舊版：標題說明更新了，先列這次改了什麼，再列完整的資料流向（政策要求改了要完整再揭露一次）。
 */
export function ConsentDisclosure({ mode, updated }: { mode: TranslationMode; updated: boolean }) {
  const changes = updated ? CONSENT_CHANGES[mode] : undefined;
  return (
    <>
      <p>
        <strong>{updated ? '資料使用說明更新了，請再確認一次' : '翻譯前請先確認資料怎麼使用'}</strong>
      </p>
      {changes && <p>這次改了：{changes}</p>}
      {mode === 'hosted' ? <HostedDataFlow /> : <OwnKeyDataFlow />}
    </>
  );
}

/** 「詳見隱私權政策、服務條款。」 */
export function PolicyLinks() {
  return (
    <>
      詳見
      <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
        隱私權政策
      </a>
      、
      <a href={TERMS_URL} target="_blank" rel="noreferrer">
        服務條款
      </a>
      。
    </>
  );
}
