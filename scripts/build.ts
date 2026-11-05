/**
 * 用法：node scripts/build.ts [--e2e | --debug]
 *   正式 build → dist/prod；e2e build → dist/e2e（多 <all_urls> 與測試入口，spec #27 第 12 節）；
 *   debug build → dist/debug（多印除錯記錄，src/shared/trace.ts；平常由 scripts/debug-chrome.ts 建到固定位置）
 *
 * 每個入口各自用 esbuild 打包，因為格式不同：
 *   - background（SW）、sidepanel、onboarding、account、offscreen：ES module
 *   - content：IIFE。scripting.executeScript({files}) 只能注入傳統 script，不能有 import。
 */
import { copyFile, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { buildManifest } from '../src/manifest.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * 原樣複製進外掛的檔案：[來源（相對 repo 根目錄）, 輸出路徑]。
 * ONNX 模型不在這裡：第一次使用時才下載（spec #27 第 3.3 節）。
 * 字型檔不打包：side panel 與覆蓋層都用系統字型（src/shared/tokens.css）；譯文只有幾個標點用 Noto Sans TC，
 * 以 base64 打包在 content script 與 side panel 的 JS 裡（src/shared/punctuation-font.ts）。
 */
const STATIC_FILES: [string, string][] = [
  ['src/sidepanel/sidepanel.html', 'sidepanel.html'],
  // design tokens（#71）：side panel 直接載入；content script 另外把它打包成字串放進 shadow DOM
  ['src/shared/tokens.css', 'tokens.css'],
  // side panel 的畫面樣式（src/ui/，#108）；sidepanel.css 只剩外掛整頁的 html／body
  ['src/ui/components.css', 'components.css'],
  ['src/ui/side-panel.css', 'side-panel.css'],
  ['src/sidepanel/sidepanel.css', 'sidepanel.css'],
  // 全新安裝時打開的全頁 onboarding（#93）：跟 side panel 共用 tokens.css、components.css
  ['src/onboarding/onboarding.html', 'onboarding.html'],
  ['src/onboarding/onboarding.css', 'onboarding.css'],
  // 帳號與訂閱頁（#213）：圖示右鍵選單、額度用完、設定頁的「管理帳號 →」打開
  ['src/account/account.html', 'account.html'],
  ['src/account/account.css', 'account.css'],
  ['src/offscreen/offscreen.html', 'offscreen.html'],
  // onnxruntime-web 不打包進 offscreen.js，執行時動態 import（見 src/offscreen/ort-engine.ts）。
  // webgpu bundle 同時支援 WebGPU 與 wasm，只會載入 asyncify 這一份 wasm（與它的 .mjs，多執行緒 worker 用）。
  ['node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs', 'ort/ort.webgpu.bundle.min.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'ort/ort-wasm-simd-threaded.asyncify.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'ort/ort-wasm-simd-threaded.asyncify.wasm'],
];

/** 原樣複製的目錄。icons：外掛 icon 的 PNG 與 side panel 標題用的 SVG 母檔（PNG 由 scripts/icons.ts 產出）。 */
const STATIC_DIRS: [string, string][] = [
  ['node_modules/kuromoji/dict', 'kuromoji/dict'],
  ['src/icons', 'icons'],
];

/** e2e build 才有：量 #7 指標用的流水線測試頁（browser/ocr-accuracy.spec.ts）、覆蓋渲染測試頁（browser/overlay-render.spec.ts）。 */
const E2E_STATIC_FILES: [string, string][] = [
  ['src/test-pipeline/test-pipeline.html', 'test-pipeline.html'],
  ['src/test-overlay/test-overlay.html', 'test-overlay.html'],
];

/** e2e build 才有：FakeEngine 認頁用的合成圖（src/offscreen/fake-engine.ts）。 */
const E2E_STATIC_DIRS: [string, string][] = [['testdata/synthetic/out', 'synthetic']];

/** browser test 與 smoke 在這個 port 啟動 wrangler dev（browser/worker.ts），e2e build 連它。 */
export const E2E_WORKER_PORT = 8788;

/**
 * Hosted Translation 的 Worker 網址（worker/）：e2e build 連測試啟動的 wrangler dev；debug build 連開發者自己跑的
 * `npm run worker:dev`（wrangler dev --env dev，預設 port 8787）；正式 build 連 production 的 Worker（worker/wrangler.jsonc 的 routes）。
 */
export function hostedApiUrl({ e2e, debug }: { e2e: boolean; debug: boolean }): string {
  return e2e ? `http://localhost:${E2E_WORKER_PORT}` : debug ? 'http://localhost:8787' : 'https://api.naruhodo.page';
}

export async function build({ e2e, debug = false, outDir }: { e2e: boolean; debug?: boolean; outDir: string }): Promise<void> {
  // 只清空內容、不刪資料夾本身：debug Chrome 載入的就是這個資料夾，整個刪掉再建，
  // 重新載入時 Chrome 曾回報「File path cannot be resolved」並卡在停用（#27 除錯）
  await mkdir(outDir, { recursive: true });
  for (const name of await readdir(outDir)) await rm(join(outDir, name), { recursive: true, force: true });

  const common: esbuild.BuildOptions = {
    absWorkingDir: root,
    bundle: true,
    outdir: outDir,
    target: 'chrome116',
    define: {
      __E2E__: String(e2e),
      __DEBUG__: String(debug),
      __HOSTED_API_URL__: JSON.stringify(hostedApiUrl({ e2e, debug })),
    },
    jsx: 'automatic',
    jsxImportSource: 'preact',
    sourcemap: e2e || debug ? 'inline' : false,
    // kuromoji 用 Node 的 path.join 拼字典網址
    alias: { path: './src/offscreen/path-shim.ts' },
    loader: { '.css': 'text' },
    logLevel: 'warning',
  };

  const files = [...STATIC_FILES, ...(e2e ? E2E_STATIC_FILES : [])];
  await Promise.all([
    esbuild.build({
      ...common,
      format: 'esm',
      entryPoints: {
        background: 'src/background/index.ts',
        sidepanel: 'src/sidepanel/main.tsx',
        onboarding: 'src/onboarding/main.tsx',
        account: 'src/account/main.tsx',
        offscreen: 'src/offscreen/index.ts',
        ...(e2e ? { 'test-pipeline': 'src/test-pipeline/main.ts', 'test-overlay': 'src/test-overlay/main.ts' } : {}),
      },
    }),
    esbuild.build({
      ...common,
      format: 'iife',
      // test-ui：注入一般網頁、證明網站能重用畫面的測試 script（browser/ui-reuse.spec.ts）
      entryPoints: { content: 'src/content/index.ts', ...(e2e ? { 'test-ui': 'src/test-ui/main.tsx' } : {}) },
    }),
    ...files.map(async ([from, to]) => {
      await mkdir(dirname(join(outDir, to)), { recursive: true });
      await copyFile(join(root, from), join(outDir, to));
    }),
    ...[...STATIC_DIRS, ...(e2e ? E2E_STATIC_DIRS : [])].map(([from, to]) => cp(join(root, from), join(outDir, to), { recursive: true })),
    writeFile(join(outDir, 'manifest.json'), JSON.stringify(buildManifest({ e2e, debug }), null, 2)),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const e2e = process.argv.includes('--e2e');
  const debug = process.argv.includes('--debug');
  const flavor = e2e ? 'e2e' : debug ? 'debug' : 'prod';
  const outDir = join(root, 'dist', flavor);
  await build({ e2e, debug, outDir });
  console.log(`built ${flavor} → ${outDir}`);
}
