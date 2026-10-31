// offscreen document：裁切截圖、Page hash、偵測＋OCR＋閱讀順序、呼叫 LLM（spec #27 第 2 節）。
// 由 SW 在需要時用 chrome.offscreen.createDocument 建立，manifest 不必宣告。
import { SYNTHETIC_GROUND_TRUTH } from '../background/synthetic-ground-truth.ts';
import { boxToRatio, ERASE_PADDING, expandBox, ratioToBox, tupleBox } from '../content/overlay-layout.ts';
import { indexedDbApiKeyStore } from '../shared/api-key-store.ts';
import { createFakeTranslator } from '../shared/fake-translator.ts';
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  CropRequest,
  CropResponse,
  FakeTranslatorConfig,
  Message,
  ModelStatus,
  PageCandidate,
  PageThumb,
  Rect,
  Size,
  TestConnectionResponse,
  TranslateResponse,
  ProposeNotesResponse,
} from '../shared/messages.ts';
import { rejectInSlice, sliceOf, stripeFingerprint, toPageText } from '../shared/long-page.ts';
import { pageHash, type GrayImage } from '../shared/page-hash.ts';
import type { BalloonText, EraseData, LooseText, PageText, RatioRect } from '../shared/page-text.ts';
import { grayOfRgba, type RgbaImage } from '../shared/pixels.ts';
import { createTrace } from '../shared/trace.ts';
import type { NotesInput, NotesOutput, TranslateInput, TranslateOutput } from '../shared/translator.ts';
import { createClaudeTranslator } from './claude-translator.ts';
import { subImageRect, thumbnailSize, toImageRect, toSubRect } from './crop.ts';
import { eraseLuminance } from './erase-color.ts';
import { eraseImage, eraseLooseText, meanLuminance, type EraseImage } from './erase-image.ts';
import { createLocalPipeline } from './local-pipeline.ts';
import { pageRgba } from './page-image.ts';
import { cropImage, splitSpread } from './spread.ts';

const trace = createTrace('offscreen');

/** side panel 縮圖的寬度（截圖像素）。 */
const THUMBNAIL_WIDTH = 240;

/**
 * 每個候選去黑邊、Spread 切成兩頁（spread.ts），每頁各自縮圖、算 hash。回傳依閱讀順序：同一個候選的
 * Spread 先右後左，side panel 與翻譯佇列都照這個順序。
 */
async function crop({ screenshot, viewport, candidates }: CropRequest): Promise<PageThumb[]> {
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  try {
    return candidates.flatMap((candidate) => {
      if (candidate.visible) return [longPageThumb(bitmap, viewport, candidate, candidate.visible)];
      const src = toImageRect(candidate.rect, viewport, bitmap);
      const gray = grayOf(bitmap, src);
      const pages = splitSpread(gray);
      if (pages.length === 0) trace('spread:unsplittable', { anchorId: candidate.anchorId, rect: candidate.rect });
      return pages.map((page): PageThumb => {
        const whole = page.width === src.width && page.height === src.height;
        const size = thumbnailSize(page, THUMBNAIL_WIDTH);
        const thumbnail = pngDataUrl(size, (ctx) => {
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(bitmap, src.x + page.x, src.y + page.y, page.width, page.height, 0, 0, size.width, size.height);
        });
        return {
          ...candidate,
          ...(whole ? {} : { subRect: toSubRect(page, src) }),
          thumbnail,
          pageHash: pageHash(cropImage(gray, page)),
        };
      });
    });
  } finally {
    bitmap.close();
  }
}

/**
 * 長 Page（spec #142）：只裁看得到的那一截，不切 Spread、不去黑邊。身分是這一截裡完整看得到的橫條指紋；
 * pageHash 先放第一條的 hash，transcriber 認出是哪個 Page 後換掉。
 */
function longPageThumb(bitmap: ImageBitmap, viewport: Size, candidate: PageCandidate, visible: Rect): PageThumb {
  const src = toImageRect(visible, viewport, bitmap);
  const scale = bitmap.height / viewport.height;
  // Page 的上緣在截圖裡的位置（可能在截圖外面，不夾）
  const pageTop = candidate.rect.y * scale;
  // 自己的覆蓋層蓋住的列，換成 Page 裡的像素
  const covered = (candidate.covered ?? []).map((r) => ({ top: r.y * scale - pageTop, bottom: (r.y + r.height) * scale - pageTop }));
  const stripes = stripeFingerprint(grayOf(bitmap, src), src.y - pageTop, covered);
  const size = thumbnailSize(src, THUMBNAIL_WIDTH);
  const thumbnail = pngDataUrl(size, (ctx) => {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, src.x, src.y, src.width, src.height, 0, 0, size.width, size.height);
  });
  return { ...candidate, thumbnail, pageHash: stripes[0]?.hash ?? '', stripes };
}

/** 全解析度的裁切轉灰階。縮小交給 pageHash 自己做，Node 的單元測試才算得一樣。 */
function grayOf(bitmap: ImageBitmap, rect: Rect): GrayImage {
  const canvas = new OffscreenCanvas(rect.width, rect.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return grayOfRgba(ctx.getImageData(0, 0, rect.width, rect.height).data, rect.width, rect.height);
}

/**
 * 畫好的圖編成 PNG data URL（messaging 是 JSON 序列化，跨 context 一律用 data URL，#4）。
 * 用 DOM 的 canvas.toDataURL，不用 OffscreenCanvas.convertToBlob：真實 Chrome 的 offscreen document
 * 沒有畫面幀，convertToBlob 每次都要等約 1 秒（#27 除錯實測；toDataURL 約 10 ms，Playwright 的 Chromium 測不出來）。
 */
function pngDataUrl(size: { width: number; height: number }, draw: (ctx: CanvasRenderingContext2D) => void): string {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  draw(canvas.getContext('2d')!);
  return canvas.toDataURL('image/png');
}

/** 上一次記錄的模型狀態：下載進度每個 chunk 都會回報一次，只記狀態改變（例如開始下載、下載完）。 */
let lastTracedModelState: ModelStatus['state'] | undefined;

const pipeline = createLocalPipeline({
  onStatus(status) {
    if (status.state !== lastTracedModelState) trace('models', { ...status });
    lastTracedModelState = status.state;
    // SW 記下最新狀態給之後打開的 side panel；已開著的 side panel 直接收到。
    chrome.runtime.sendMessage({ type: 'models:status', status } satisfies Message).catch(() => {});
  },
});

/**
 * 從截圖裁出全解析度的 Page（Spread 的一頁用 subRect）跑本機流水線（座標換算與縮圖相同）；順便從同一張截圖算每個 Balloon 的擦除底色
 * （原地覆蓋用，canvas 網站的 canvas 是 tainted，content script 讀不到像素）。
 */
async function analyze({ screenshot, viewport, candidate, subRect, collected = [], pipeline: config }: AnalyzeRequest): Promise<PageText> {
  if (__E2E__ && config) pipeline.configure(config);
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  try {
    const candidateRect = toImageRect(candidate.visible ?? candidate.rect, viewport, bitmap);
    const rect = subRect ? subImageRect(candidateRect, subRect) : candidateRect;
    // 長 Page（spec #142）：只跑看得到的那一截，被切到的與已收過的框不做 OCR
    const slice = candidate.visible && sliceOf(candidate.rect, candidate.visible);
    const rejected: { box: RatioRect; reason: string }[] = [];
    const accept = slice
      ? (box: RatioRect) => {
          const reason = rejectInSlice(box, slice, rect.height, collected);
          if (reason) rejected.push({ box, reason });
          return reason === undefined;
        }
      : undefined;
    const startedAt = performance.now();
    const analyzed = await pipeline.analyze(bitmap, rect, accept);
    // 被切到、重疊而不收的框；tooTall＝比可見範圍還高，永遠收不到（已知限制）
    if (__DEBUG__ && slice && rejected.length > 0) trace('longPage:rejected', { anchorId: candidate.anchorId, slice, rejected });
    const eraseStartedAt = performance.now();
    const rgba = pageRgba(bitmap, rect);
    const text = { balloons: eraseBalloons(analyzed.balloons, rgba), looseText: eraseLoose(analyzed.looseText, rgba) };
    if (__DEBUG__) {
      trace('analyze', {
        anchorId: candidate.anchorId,
        subRect,
        imageRect: rect,
        ms: Math.round(performance.now() - startedAt),
        // 擦除小圖（Balloon #149、Loose Text #151）佔的時間，已含在 ms 裡
        eraseMs: Math.round(performance.now() - eraseStartedAt),
        eraseFallbacks: text.balloons.filter((b) => !b.erase).map((b) => b.id),
        balloons: text.balloons.map(({ id, order, orientation, 原文, ocrConfidence, balloonBbox, textBbox }) => ({ id, order, orientation, 原文, ocrConfidence, balloonBbox, textBbox })),
        looseText: text.looseText.map(({ id, order, orientation, 原文, ocrConfidence, bbox }) => ({ id, order, orientation, 原文, ocrConfidence, bbox })),
        // 這時還沒翻譯，unreadable 只會來自 OCR 信心門檻（ADR 0009）
        lowConfidence: [...text.balloons, ...text.looseText].filter((t) => t.unreadable).length,
        detections: detectionImage(bitmap, rect, text),
      });
    }
    // 長 Page：這一截的座標換成 Page 座標，transcriber 併進整個 Page
    return slice ? toPageText(text, slice) : text;
  } finally {
    bitmap.close();
  }
}

/**
 * 每個 Balloon 的擦除底色（文字色與矩形退路用）與擦除小圖（#149）。小圖編成 PNG data URL 才能隨 PageText
 * 走 messaging、存進快取；中央找不到底色時沒有小圖，覆蓋層退回矩形。
 */
function eraseBalloons(balloons: BalloonText[], page: RgbaImage): BalloonText[] {
  const gray = grayOfRgba(page.data, page.width, page.height);
  return balloons.map((b) => {
    const text = ratioToBox(b.textBbox, page);
    const luminance = eraseLuminance(gray, expandBox(text, ERASE_PADDING));
    const erase = eraseImage(page, ratioToBox(b.balloonBbox, page), text);
    // 排版矩形（#150）只有 Balloon 有；Loose Text 的排版區是文字框本身
    return erase ? { ...b, eraseLuminance: luminance, erase: { ...encodeErase(erase, page), fit: boxToRatio(tupleBox(erase.fit), page) } } : { ...b, eraseLuminance: luminance };
  });
}

/**
 * Loose Text 的擦除小圖與字色用的平均亮度（#151）。翻譯前還不知道哪段是 Sound Effect，所以 unreadable 以外的都算；
 * 要不要覆蓋由 content script 決定（overlaidTexts）。
 */
function eraseLoose(looseText: LooseText[], page: RgbaImage): LooseText[] {
  return looseText.map((l) => {
    if (l.unreadable) return l;
    const erase = eraseLooseText(page, ratioToBox(l.bbox, page));
    return { ...l, eraseLuminance: Math.round(meanLuminance(erase)), erase: encodeErase(erase, page) };
  });
}

/** 小圖編成 PNG data URL 才能隨 PageText 走 messaging、存進快取；位置換成相對 Page 的比例。 */
function encodeErase({ box, rgba }: EraseImage, page: RgbaImage): EraseData {
  const [, , w, h] = box;
  const image = pngDataUrl({ width: w, height: h }, (ctx) => ctx.putImageData(new ImageData(rgba, w, h), 0, 0));
  return { box: boxToRatio(tupleBox(box), page), image };
}


/**
 * debug build 才用：裁好的 Page 疊上偵測結果（藍＝Balloon 外框、紅＝文字框、綠＝Loose Text，數字是閱讀順序），
 * 對照 OCR 漏字或覆蓋位置。
 */
function detectionImage(bitmap: ImageBitmap, rect: Rect, text: PageText): string {
  return pngDataUrl(rect, (ctx) => drawDetections(ctx, bitmap, rect, text));
}

function drawDetections(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap, rect: Rect, text: PageText): void {
  ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  const line = Math.max(2, Math.round(rect.width / 400));
  ctx.lineWidth = line;
  ctx.font = `bold ${line * 10}px sans-serif`;
  const stroke = (box: { x: number; y: number; w: number; h: number }, color: string, label?: number) => {
    const [x, y, w, h] = [box.x * rect.width, box.y * rect.height, box.w * rect.width, box.h * rect.height];
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, w, h);
    if (label === undefined) return;
    ctx.fillStyle = color;
    ctx.fillText(String(label), x + line, y + line * 10);
  };
  for (const b of text.balloons) {
    stroke(b.balloonBbox, '#1e6fff', b.order);
    stroke(b.textBbox, '#ff2d2d');
  }
  for (const l of text.looseText) stroke(l.bbox, '#18b84a', l.order);
}

const apiKeys = indexedDbApiKeyStore();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** API key 只在這裡讀出來、只送到 api.anthropic.com（spec 第 5 節）。 */
async function claude() {
  const apiKey = await apiKeys.get();
  if (!apiKey) return undefined;
  return createClaudeTranslator({ apiKey, fetch: (url, init) => fetch(url, init), sleep, now: () => performance.now() });
}

class NoApiKeyError extends Error {}

async function translate(input: TranslateInput, fake: FakeTranslatorConfig | undefined): Promise<TranslateOutput> {
  // e2e build 才有：FakeTranslator 取代 Claude（正式 build 裡 __E2E__ 是 false，整段與 ground truth 都不會打包）
  if (__E2E__ && fake) return createFakeTranslator(SYNTHETIC_GROUND_TRUTH, fake).translatePage(input);
  const translator = await claude();
  if (!translator) throw new NoApiKeyError('尚未設定 API key');
  trace('translate:request', { input });
  try {
    const output = await translator.translatePage(input);
    trace('translate:response', { output });
    return output;
  } catch (e) {
    trace('translate:error', { error: e });
    throw e;
  }
}

/** ②（ADR 0005）：失敗由 SW 跳過，不重試。 */
async function proposeNotes(input: NotesInput, fake: FakeTranslatorConfig | undefined): Promise<NotesOutput> {
  if (__E2E__ && fake) return createFakeTranslator(SYNTHETIC_GROUND_TRUTH, fake).proposeNotes(input);
  const translator = await claude();
  if (!translator) throw new NoApiKeyError('尚未設定 API key');
  trace('notes:request', { input });
  try {
    const output = await translator.proposeNotes(input);
    trace('notes:response', { output });
    return output;
  } catch (e) {
    trace('notes:error', { error: e });
    throw e;
  }
}

async function testConnection(): Promise<TestConnectionResponse> {
  try {
    const translator = await claude();
    if (!translator) return { ok: false, error: '尚未設定 API key' };
    return { ok: true, ...(await translator.testConnection()) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'offscreen:crop') {
    crop(message).then(
      (pages) => sendResponse({ pages } satisfies CropResponse),
      (e: unknown) => sendResponse({ error: String(e) } satisfies CropResponse),
    );
    return true;
  }
  if (message.type === 'offscreen:analyze') {
    analyze(message).then(
      (text) => sendResponse({ text } satisfies AnalyzeResponse),
      (e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) } satisfies AnalyzeResponse),
    );
    return true;
  }
  if (message.type === 'offscreen:translate') {
    translate(message.input, message.fake).then(
      (output) => sendResponse({ output } satisfies TranslateResponse),
      (e: unknown) =>
        sendResponse({
          error: e instanceof Error ? e.message : String(e),
          ...(e instanceof NoApiKeyError ? { noApiKey: true as const } : {}),
        } satisfies TranslateResponse),
    );
    return true;
  }
  if (message.type === 'offscreen:proposeNotes') {
    proposeNotes(message.input, message.fake).then(
      (output) => sendResponse({ output } satisfies ProposeNotesResponse),
      (e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) } satisfies ProposeNotesResponse),
    );
    return true;
  }
  if (message.type === 'offscreen:testConnection') {
    testConnection().then(sendResponse);
    return true;
  }
  return false;
});
