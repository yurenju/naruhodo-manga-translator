import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from './build.ts';

let prodDir: string;
let e2eDir: string;
let debugDir: string;

beforeAll(async () => {
  prodDir = await mkdtemp(join(tmpdir(), 'manga-prod-'));
  e2eDir = await mkdtemp(join(tmpdir(), 'manga-e2e-'));
  debugDir = await mkdtemp(join(tmpdir(), 'manga-debug-'));
  await Promise.all([
    build({ e2e: false, outDir: prodDir }),
    build({ e2e: true, outDir: e2eDir }),
    build({ e2e: false, debug: true, outDir: debugDir }),
  ]);
}, 30_000);

afterAll(async () => {
  await Promise.all([prodDir, e2eDir, debugDir].map((dir) => rm(dir, { recursive: true, force: true })));
});

const readJson = async (dir: string, file: string) => JSON.parse(await readFile(join(dir, file), 'utf8'));
const readText = (dir: string, file: string) => readFile(join(dir, file), 'utf8');
const exists = (dir: string, file: string) => access(join(dir, file)).then(() => true, () => false);

describe('正式 build', () => {
  it('manifest 只含 spec 第 6 節的權限，沒有 host 權限與靜態 content script', async () => {
    const manifest = await readJson(prodDir, 'manifest.json');

    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'offscreen', 'scripting', 'sidePanel', 'storage', 'unlimitedStorage']);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.commands).toBeDefined();
  });

  it('產出四種入口：service worker、offscreen、side panel、可動態注入的 content script', async () => {
    const manifest = await readJson(prodDir, 'manifest.json');

    expect(await readText(prodDir, manifest.background.service_worker)).not.toBe('');
    expect(manifest.side_panel.default_path).toBe('sidepanel.html');
    expect(await readText(prodDir, 'sidepanel.html')).toContain('sidepanel.js');
    expect(await readText(prodDir, 'offscreen.html')).toContain('offscreen.js');
    // executeScript({files}) 只能載入傳統 script：不能有 import／export。
    const content = await readText(prodDir, 'content.js');
    expect(content).not.toMatch(/^\s*(import|export)\b/m);
  });

  it('Hosted Translation 連 production 的 Worker', async () => {
    expect(await readText(prodDir, 'background.js')).toContain('"https://api.naruhodo.page"');
  });

  it('不包含 e2e 測試入口、FakeTranslator 與合成頁 ground truth', async () => {
    const sw = await readText(prodDir, 'background.js');

    expect(sw).not.toContain('test:activate');
    expect(sw).not.toContain('test:configure');
    // 沒 minify 時死分支的程式碼還在（if (false) {...}），但它引用的模組不會被打包進來。
    expect(sw).not.toContain('FakeTranslator：找不到對應的原文');
    expect(sw).not.toContain('早安！今天好早喔');
    expect(await exists(prodDir, 'test-pipeline.html')).toBe(false);
    expect(await exists(prodDir, 'test-overlay.html')).toBe(false);
    // FakeTranslator 在 #31 搬到 offscreen
    const offscreen = await readText(prodDir, 'offscreen.js');
    expect(offscreen).not.toContain('FakeTranslator：找不到對應的原文');
    expect(offscreen).not.toContain('早安！今天好早喔');
    // FakeEngine 與錄好的 OCR 結果（ADR 0007）
    expect(offscreen).not.toContain('FakeEngine 認不出這是哪張合成頁');
    expect(offscreen).not.toContain('おはよう');
  });

  it('不包含除錯記錄（debug build 才有）', async () => {
    for (const file of ['background.js', 'offscreen.js', 'content.js']) expect(await readText(prodDir, file)).not.toContain('[manga-trace]');
  });

  it('API key：只有 offscreen 呼叫 API；content script 碰不到 key 的 store，SW 不帶 key', async () => {
    const [content, sw, offscreen, panel] = await Promise.all(
      ['content.js', 'background.js', 'offscreen.js', 'sidepanel.js'].map((f) => readText(prodDir, f)),
    );

    expect(offscreen).toContain('x-api-key');
    expect(offscreen).toContain('anthropic-dangerous-direct-browser-access');
    for (const bundle of [content, sw, panel]) expect(bundle).not.toContain('x-api-key');
    expect(content).not.toContain('apiKeys');
    expect(content).not.toContain('indexedDB');
  });

  it('Hosted Translation：還沒有 Worker 網址（#90）', async () => {
    const [sw, panel] = await Promise.all(['background.js', 'sidepanel.js'].map((f) => readText(prodDir, f)));

    for (const bundle of [sw, panel]) {
      expect(bundle).not.toContain('localhost');
    }
  });

  it('打包 onnxruntime-web 的 wasm 與 kuromoji 字典，但不打包 ONNX 模型（第一次使用時才下載）', async () => {
    expect(await exists(prodDir, 'ort/ort.webgpu.bundle.min.mjs')).toBe(true);
    expect(await exists(prodDir, 'ort/ort-wasm-simd-threaded.asyncify.wasm')).toBe(true);
    expect(await exists(prodDir, 'kuromoji/dict/base.dat.gz')).toBe(true);
    const files = await readdir(prodDir, { recursive: true });
    expect(files.filter((f) => f.endsWith('.onnx'))).toEqual([]);
  });

  it('打包覆蓋層用的 Noto Sans TC 700 子集與授權，只開放字型檔給網頁讀取', async () => {
    const manifest = await readJson(prodDir, 'manifest.json');
    const fonts = await readdir(join(prodDir, 'fonts'));

    // content script 依 700.css 的 url() 找子集，每一個都要在
    const css = await readFile('node_modules/@fontsource/noto-sans-tc/700.css', 'utf8');
    const referenced = [...css.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(100);
    expect(fonts.filter((f) => f.endsWith('.woff2')).sort()).toEqual([...new Set(referenced)].sort());
    expect(fonts).toContain('LICENSE');
    expect(manifest.web_accessible_resources).toEqual([{ resources: ['fonts/*'], matches: ['<all_urls>'] }]);
  });

  it('外掛頁面 cross-origin isolated，onnxruntime-web 的 wasm 才能多執行緒', async () => {
    const manifest = await readJson(prodDir, 'manifest.json');

    expect(manifest.cross_origin_embedder_policy).toEqual({ value: 'require-corp' });
    expect(manifest.cross_origin_opener_policy).toEqual({ value: 'same-origin' });
  });

  it('外掛 icon 與工具列 icon 都指向打包進去的 16/32/48/128 px PNG', async () => {
    const manifest = await readJson(prodDir, 'manifest.json');
    const expected = { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' };

    expect(manifest.icons).toEqual(expected);
    expect(manifest.action.default_icon).toEqual(expected);
    for (const [size, file] of Object.entries(expected)) {
      const png = await readFile(join(prodDir, file));
      // PNG 的 IHDR：寬高在第 16、20 byte
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([Number(size), Number(size)]);
    }
  });

  it('side panel 標題旁的 logo 用同一份 SVG 母檔', async () => {
    expect(await readText(prodDir, 'icons/naruhodo.svg')).toBe(await readFile('src/icons/naruhodo.svg', 'utf8'));
  });

  it('CSP 只多開放編譯 wasm，不開放 eval 與外部 script', async () => {
    const manifest = await readJson(prodDir, 'manifest.json');

    expect(manifest.content_security_policy).toEqual({ extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" });
  });
});

describe('e2e build', () => {
  it('多宣告 <all_urls>，並包含測試入口', async () => {
    const manifest = await readJson(e2eDir, 'manifest.json');
    const sw = await readText(e2eDir, 'background.js');

    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(sw).toContain('test:activate');
  });

  it('Hosted Translation 連測試啟動的本機 Worker（port 8788）', async () => {
    const sw = await readText(e2eDir, 'background.js');

    expect(sw).toContain('"http://localhost:8788"');
  });

  it('多一個量 #7 指標用的流水線測試頁與覆蓋渲染測試頁', async () => {
    expect(await readText(e2eDir, 'test-pipeline.html')).toContain('test-pipeline.js');
    expect(await readText(e2eDir, 'test-overlay.html')).toContain('test-overlay.js');
  });

  it('多一個注入一般網頁的 UI 測試 script（#108），是傳統 script；正式 build 沒有', async () => {
    expect(await readText(e2eDir, 'test-ui.js')).not.toMatch(/^\s*(import|export)\b/m);
    expect(await exists(prodDir, 'test-ui.js')).toBe(false);
  });
});

describe('debug build', () => {
  it('三個流水線 context 都印除錯記錄', async () => {
    const manifest = await readJson(debugDir, 'manifest.json');

    for (const file of ['background.js', 'offscreen.js', 'content.js']) expect(await readText(debugDir, file)).toContain('[manga-trace]');
    expect(manifest.name).toBe('Naruhodo (debug)');
  });

  it('跟 e2e build 一樣多宣告 <all_urls> 與啟動入口，agent 不用點圖示就能啟動（#112）', async () => {
    const [manifest, prodManifest] = await Promise.all([readJson(debugDir, 'manifest.json'), readJson(prodDir, 'manifest.json')]);

    expect(manifest.permissions).toEqual(prodManifest.permissions);
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(await readText(debugDir, 'background.js')).toContain('test:activate');
  });

  it('Hosted Translation 連開發者自己跑的 `wrangler dev --env dev`（port 8787）', async () => {
    expect(await readText(debugDir, 'background.js')).toContain('"http://localhost:8787"');
  });
});
