/**
 * 資料使用說明的版本與變更摘要（Data Use Consent，shared/data-consent.ts）。單獨一個檔案、不碰 chrome.*：
 * src/ui 的說明卡（data-flow.tsx）也會被產品網站 import。
 * 只有 Material Change 才升版（ADR 0015、GLOSSARY）；界線內的新欄位、新設定、改寫文字只寫進政策的變更紀錄。
 */
import type { TranslationMode } from './translation-mode.ts';

/** 每種翻譯模式目前的說明版本；版本 5 以前兩種模式一起升版，6 起各自升。 */
export const DATA_CONSENT_VERSION: Readonly<Record<TranslationMode, number>> = { hosted: 6, ownKey: 5 };

/**
 * 上一版到目前版本改了什麼，同意過舊版的讀者在補同意卡上先看到這一行；undefined＝這次升版跟這個模式無關，不顯示。
 * 升版時跟著改（data-flow.tsx 開頭的 checklist）。
 */
export const CONSENT_CHANGES: Readonly<Record<TranslationMode, string | undefined>> = {
  hosted: '用量紀錄會記外掛產生的隨機作品編號（看不出是哪部作品）與外掛的使用情況，也用來改善成本與翻譯品質；之後在這個範圍內新增的數字不會再問你。',
  // Own API Key 沒有用量紀錄，政策改成類別寫法不算 Material Change（#341）
  ownKey: undefined,
};
