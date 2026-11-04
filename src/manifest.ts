// 版本號只寫在 package.json，由 release workflow 更新（.github/workflows/release.yml）
import pkg from '../package.json' with { type: 'json' };

/** 外掛 icon 的尺寸：工具列 16/32、管理頁 48、安裝與 Web Store 128。PNG 由 scripts/icons.ts 從 SVG 母檔產出。 */
export const ICON_SIZES = [16, 32, 48, 128] as const;

const icons = Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icons/icon-${size}.png`]));

/**
 * 權限照 spec #27 第 6 節：沒有 host_permissions、沒有靜態 content_scripts，
 * 也不用 openPanelOnActionClick（ADR 0003）。e2e build 額外宣告 <all_urls>（第 12 節）；debug build 只改名字。
 *
 * 與 ADR 0003 的差異：ADR 只列 activeTab＋scripting＋sidePanel，這裡多了 offscreen（ADR 0001）
 * 與 unlimitedStorage（ADR 0002）。spec #27 第 13 節第 6 項決定以合併後的清單為準。
 * storage：Page Mode 存在 chrome.storage.local（spec #70、#73），沒有安裝警告。
 * contextMenus：圖示的右鍵選單（「啟動時打開側邊欄」「打開側邊欄」，#185），沒有安裝警告。
 * minimum_chrome_version 141：圖示當開關、停止時用 sidePanel.close() 關掉 side panel（#185）。
 */
export function buildManifest({ e2e, debug = false }: { e2e: boolean; debug?: boolean }): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    // 名稱帶上用途，在 Web Store 搜尋結果裡跟同名的外掛分得開；空間小的地方用 short_name
    name: e2e ? 'Naruhodo (e2e)' : debug ? 'Naruhodo (debug)' : 'Naruhodo 日文漫畫翻譯',
    short_name: 'Naruhodo',
    version: pkg.version,
    // 也是 Web Store 的摘要（最多 132 字），見 docs/webstore/listing.md
    description: '把畫面上的日文漫畫原地翻成繁體中文，並列出原文、讀音與譯文，邊看邊學日文',
    minimum_chrome_version: '141',
    icons,
    permissions: ['activeTab', 'scripting', 'sidePanel', 'offscreen', 'storage', 'unlimitedStorage', 'contextMenus'],
    // e2e 與 debug build 不靠點圖示拿 activeTab，改由測試或 agent 送 test:activate 啟動（debug：#112）
    ...(e2e || debug ? { host_permissions: ['<all_urls>'] } : {}),
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_title: '漫畫翻譯：在這個分頁啟動或停止', default_icon: icons },
    side_panel: { default_path: 'sidepanel.html' },
    // 讓外掛頁面（offscreen document）crossOriginIsolated，onnxruntime-web 的 wasm 才能用 SharedArrayBuffer 多執行緒。
    // 外掛頁面只載入自己的檔案、data URL，以及有 CORS 的 Hugging Face 下載，require-corp 不會擋到。
    cross_origin_embedder_policy: { value: 'require-corp' },
    cross_origin_opener_policy: { value: 'same-origin' },
    // MV3 預設的 extension_pages CSP 不允許編譯 wasm；onnxruntime-web 需要 'wasm-unsafe-eval'（不需要 'unsafe-eval'）。
    // 覆蓋層字型（#32）：content script 在網頁 origin 下 fetch，所以要對所有網站開放（只有字型檔）。
    // 這不是 host 權限，外掛不會因此多讀到任何網站；代價是網站能探測到外掛有裝。
    web_accessible_resources: [{ resources: ['fonts/*'], matches: ['<all_urls>'] }],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    commands: {
      activate: {
        suggested_key: { default: 'Alt+Shift+M' },
        description: '在這個分頁啟動或停止漫畫翻譯',
      },
    },
  };
}
