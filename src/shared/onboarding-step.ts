/**
 * 卡住時要解決的那一步：signIn＝side panel 的「登入」「改用內建翻譯」、點圖示時沒登入或沒同意（onboarding）；plan＝額度 0（帳號頁，#213）；
 * ownKey＝點圖示時自備金鑰沒有 key（#185）。單獨一個檔案、不碰 chrome.*：Page 上的狀態（page-status.ts）經過 messages.ts
 * 也會被 Worker 的 typecheck 讀到。
 */
export type RequestedStep = 'signIn' | 'plan' | 'ownKey';
