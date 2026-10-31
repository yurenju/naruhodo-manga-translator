/**
 * 兩種翻譯模式的資料流向說明（#93）：讀者按「同意並寄送驗證碼」「同意並儲存」「同意並啟用翻譯」時同意的就是這些文字。
 * 內建翻譯：onboarding 第 2 步與設定的登入（SignIn）；自備金鑰：onboarding 的「使用自備金鑰」與 side panel 的資料使用說明卡。
 * 內容要跟 PRIVACY.md 一致；資料處理方式改了，兩邊一起改，並把 shared/data-consent.ts 的 DATA_CONSENT_VERSION 加一。
 */
import { PRIVACY_URL, TERMS_URL } from './links.ts';

const LOCAL = '對話框偵測與文字辨識都在這台電腦上進行，不會上傳圖片，也不會送出網址。';

export function HostedDataFlow() {
  return (
    <ul>
      <li>{LOCAL}</li>
      <li>辨識出的日文文字、同一部作品前幾頁的原文與譯文、作品的譯名表、你為作品取的名稱，會傳到 Naruhodo 的服務，再交給 Anthropic 翻譯。Naruhodo 的服務不保存這些文字與作品名。</li>
      <li>Naruhodo 的服務會保存你的 email、登入紀錄、剩餘頁數、訂閱狀態與每次翻譯的用量（不含內容）；驗證碼信由 Resend 寄出。</li>
    </ul>
  );
}

export function OwnKeyDataFlow() {
  return (
    <ul>
      <li>{LOCAL}</li>
      <li>辨識出的日文文字、前幾頁的原文與譯文、作品的譯名表、你為作品取的名稱，會用你的 API key 直接傳到 Anthropic 翻譯，不經過 Naruhodo 的服務。</li>
      <li>API key 只存在這台電腦的外掛裡。</li>
    </ul>
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
