import { defineConfig } from 'astro/config';
import type { Plugin } from 'vite';

/**
 * 首頁展示（#109）直接打包外掛的 side panel 與覆蓋層：外掛的 .ts 模組 import 的 .css 是字串（esbuild 的 text
 * loader，scripts/build.ts），要放進 shadow root。Vite 預設會把 .css 注入成全域樣式，所以從 .ts／.tsx import 的
 * .css 一律改成 ?raw；.astro 頁面 import 的（Base.astro 的 tokens.css、site.css）照舊是全域樣式。
 */
function cssImportedByScriptsAsText(): Plugin {
  return {
    name: 'naruhodo:css-imported-by-scripts-as-text',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!source.endsWith('.css') || !importer || !/\.tsx?$/.test(importer)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && `${resolved.id}?raw`;
    },
  };
}

// 產品網站（#89）：先輸出純靜態頁面，跟 api. 的 Worker 分開部署。
// 共用外掛的 src/（tokens.css、logo、展示用的元件）與根目錄的 PRIVACY.md、testdata/synthetic 的合成頁，所以允許讀上一層。
export default defineConfig({
  // Worker 的 SITE_ORIGIN 寫死 4321：被占用時直接報錯，不要默默換 port 讓 checkout 開到別的網站
  server: { port: 4321, strictPort: true },
  vite: {
    server: { fs: { allow: ['..'] } },
    plugins: [cssImportedByScriptsAsText()],
    // 外掛 build 時的常數（scripts/build.ts）：網站等於正式 build
    define: { __E2E__: 'false', __DEBUG__: 'false' },
  },
});
