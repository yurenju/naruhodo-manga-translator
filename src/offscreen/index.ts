// offscreen document：裁切截圖、Page hash、偵測＋OCR＋閱讀順序、呼叫 LLM（spec #27 第 2 節）。
// 由 SW 在需要時用 chrome.offscreen.createDocument 建立，manifest 不必宣告。
import { SYNTHETIC_GROUND_TRUTH } from '../background/synthetic-ground-truth.ts';
import { boxToRatio, ERASE_PADDING, expandBox, ratioToBox, tupleBox } from '../content/overlay-layout.ts';
import { indexedDbApiKeyStore } from '../shared/api-key-store.ts';
import { createFakeTranslator } from '../shared/fake-translator.ts';
import { frameMarkGeometry, judgeFrame, type FrameMark, type FrameVerdict } from '../shared/frame-mark.ts';
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  CropRequest,
  CropResponse,
  FakeTranslatorConfig,
  KuromojiReadingsResponse,
  LineBox,
  Message,
  ModelStatus,
  PageCandidate,
  PageThumb,
  PreviousCapture,
  Rect,
  Size,
  TestConnectionResponse,
  TranslateResponse,
  ProposeNotesResponse,
  GuessSeriesResponse,
} from '../shared/messages.ts';
import { collectedBoxes, cutEdges, rejectInSlice, sliceOf, stripeFingerprint, toPageText, waitingBoxes, type CutBox, type Slice, type SliceEdges } from '../shared/long-page.ts';
import { pageHash, type GrayImage } from '../shared/page-hash.ts';
import type { BalloonText, EraseData, LooseText, PageText, RatioRect } from '../shared/page-text.ts';
import { grayOfRgba, type RgbaImage } from '../shared/pixels.ts';
import { junctionVerdict, stitchWindow, type JunctionMeasure, type Rows } from '../shared/strip.ts';
import { createTrace } from '../shared/trace.ts';
import type { NotesInput, NotesOutput, SeriesGuessOutput, TitleSignals, TranslateInput, TranslateOutput } from '../shared/translator.ts';
import { createClaudeTranslator } from './claude-translator.ts';
import { subImageRect, thumbnailSize, toImageRect, toSubRect } from './crop.ts';
import { eraseLuminance } from './erase-color.ts';
import { createKuromojiReading } from './kuromoji-reading.ts';
import { eraseBalloon, eraseLooseText, meanLuminance, type EraseImage } from './erase-image.ts';
import { createLocalPipeline } from './local-pipeline.ts';
import { detectExecutionProvider } from './models/model-files.ts';
import { pageRgba } from './page-image.ts';
import type { SegmentNameFix } from './pipeline/name-fix.ts';
import { cropImage, splitSpread } from './spread.ts';

const trace = createTrace('offscreen');

/** side panel 縮圖的寬度（截圖像素）。 */
const THUMBNAIL_WIDTH = 240;

/**
 * 每個候選去黑邊、Spread 切成兩頁（spread.ts），每頁各自縮圖、算 hash。回傳依閱讀順序：同一個候選的
 * Spread 先右後左，side panel 與翻譯佇列都照這個順序。
 */
async function crop({ screenshot, frameMark, viewport, candidates }: CropRequest): Promise<{ pages: PageThumb[]; frame: FrameVerdict }> {
  const { bitmap, frame } = await decodeScreenshot(screenshot, viewport, frameMark);
  try {
    if (frame !== 'fresh') trace('capture:frame', { frame, frameMark });
    const pages = candidates.flatMap((candidate) => {
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
    const junctions = columnJunctions(bitmap, viewport, candidates);
    if (__DEBUG__ && junctions.size > 0) trace('strip:junctions', { junctions: [...junctions].map(([anchorId, measure]) => ({ anchorId, ...measure })) });
    return { pages: pages.map((page) => (junctions.has(page.anchorId) ? { ...page, junctionAbove: junctions.get(page.anchorId)!.verdict } : page)), frame };
  } finally {
    bitmap.close();
  }
}

/** 交界離整串看得到的範圍的上下緣至少這麼多截圖像素才量：太靠邊時那一列可能是可見範圍外面的東西。 */
const JUNCTION_MARGIN = 4;

/**
 * 直式排版的一串（#282）裡，出現在截圖上的每個交界：上面元素的最後一列與下面元素的第一列接不接得起來
 * （shared/strip.ts）。key＝交界下面那個元素的 anchorId。canvas 多半讀不到像素（跨來源），所以從截圖量。
 */
function columnJunctions(bitmap: ImageBitmap, viewport: Size, candidates: readonly PageCandidate[]): Map<string, JunctionMeasure> {
  const scale = bitmap.height / viewport.height;
  const junctions = new Map<string, JunctionMeasure>();
  const byColumn = new Map<string, PageCandidate[]>();
  for (const c of candidates) if (c.column) byColumn.set(c.column.id, [...(byColumn.get(c.column.id) ?? []), c]);
  for (const members of byColumn.values()) {
    members.sort((a, b) => a.rect.y - b.rect.y);
    for (const [i, lower] of members.entries()) {
      const upper = members[i - 1];
      if (!upper || Math.abs(upper.rect.y + upper.rect.height - lower.rect.y) > 2) continue;
      const region = toImageRect(lower.column!.region, viewport, bitmap);
      // 元素的邊會對齊到裝置像素：交界那一條線的上面一列屬於上面的元素，下面一列屬於下面的
      const row = Math.round(lower.rect.y * scale);
      if (row - 1 < region.y + JUNCTION_MARGIN || row + 1 > region.y + region.height - JUNCTION_MARGIN || region.width < 8) continue;
      const line = (y: number) => grayOf(bitmap, { x: region.x + 2, y, width: region.width - 4, height: 1 }).gray;
      junctions.set(lower.anchorId, junctionVerdict(line(row - 1), line(row)));
    }
  }
  return junctions;
}

/**
 * 解碼截圖、讀 frame 記號（shared/frame-mark.ts），再用記號右邊那一行像素蓋掉它：記號不能進 hash、去黑邊與 OCR。
 */
async function decodeScreenshot(screenshot: string, viewport: Size, mark: FrameMark): Promise<{ bitmap: ImageBitmap; frame: FrameVerdict }> {
  const raw = await createImageBitmap(await (await fetch(screenshot)).blob());
  const canvas = new OffscreenCanvas(raw.width, raw.height);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(raw, 0, 0);
  const { samples, eraseRect } = frameMarkGeometry(viewport, raw);
  raw.close();
  const rgb = ({ x, y }: { x: number; y: number }) => {
    const [r = 0, g = 0, b = 0] = ctx.getImageData(x, y, 1, 1).data;
    return [r, g, b] as const;
  };
  const frame = judgeFrame(rgb(samples[0]), rgb(samples[1]), mark);
  const { width, height } = eraseRect;
  if (width < canvas.width && height <= canvas.height) ctx.drawImage(canvas, width, 0, 1, height, 0, 0, width, height);
  return { bitmap: canvas.transferToImageBitmap(), frame };
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
 * waiting：長 Page 的這一截裡被可見範圍邊緣切到、這次沒收的框（#283）。
 */
async function analyze({ screenshot, frameMark, viewport, candidate, subRect, collected = [], column, notesNames = [], pipeline: config }: AnalyzeRequest): Promise<{ text: PageText; waiting?: LineBox[] }> {
  if (__E2E__ && config) pipeline.configure(config);
  const { bitmap } = await decodeScreenshot(screenshot, viewport, frameMark);
  try {
    const candidateRect = toImageRect(candidate.visible ?? candidate.rect, viewport, bitmap);
    const rect = subRect ? subImageRect(candidateRect, subRect) : candidateRect;
    // 長 Page（spec #142）：只跑看得到的那一截，被切到的與已收過的框不做 OCR。
    // 直式排版的一串（#282）：這一截是整串看得到的範圍，只收中心落在這個 Page 裡的框
    const slice = candidate.visible && sliceOf(candidate.rect, candidate.visible);
    const edges: SliceEdges | undefined = column && { top: column.cutTop, bottom: column.cutBottom };
    const rejected: { box: RatioRect; reason: string }[] = [];
    /** 被這一截的上緣／下緣切到的框（截圖像素）：有上一次的截圖時拼起來再辨識。 */
    const cutTop: Rows[] = [];
    const cutBottom: Rows[] = [];
    /** 被切到、先不收的框：沒有被拼接補收的那些，content script 在上面畫等待中的外圈（#283）。 */
    const cut: CutBox[] = [];
    const accept = slice
      ? (box: RatioRect, kind: CutBox['kind']) => {
          const reason = rejectInSlice(box, slice, rect.height, collected, edges);
          if (reason) rejected.push({ box, reason });
          if (reason === 'cut') cut.push({ box, kind });
          if (reason === 'cut' && edges) {
            const rows = { top: rect.y + box.y * rect.height, bottom: rect.y + (box.y + box.h) * rect.height };
            (cutEdges(box, rect.height, edges).top ? cutTop : cutBottom).push(rows);
          }
          return reason === undefined;
        }
      : undefined;
    const startedAt = performance.now();
    // OCR 原本讀到的字只出現在 trace（#228）。長 Page 的 id 是這一截的編號，併進整個 Page 時會重編
    const nameFixes: SegmentNameFix[] = [];
    const analyzed = await pipeline.analyze(bitmap, rect, { accept, notesNames, onNameFix: (fix) => nameFixes.push(fix) });
    if (nameFixes.length > 0) trace('ocr:nameFix', { anchorId: candidate.anchorId, subRect, fixes: nameFixes });
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
        balloons: text.balloons.map(({ id, order, orientation, 原文, ocrConfidence, ocrDropped, balloonBbox, textBbox }) => ({ id, order, orientation, 原文, ocrConfidence, ocrDropped, balloonBbox, textBbox })),
        looseText: text.looseText.map(({ id, order, orientation, 原文, ocrConfidence, ocrDropped, bbox }) => ({ id, order, orientation, 原文, ocrConfidence, ocrDropped, bbox })),
        // 這時還沒翻譯，unreadable 只會來自 OCR 信心門檻（ADR 0009）
        lowConfidence: [...text.balloons, ...text.looseText].filter((t) => t.unreadable).length,
        detections: detectionImage(bitmap, rect, text),
      });
    }
    // 長 Page：這一截的座標換成 Page 座標，transcriber 併進整個 Page
    if (!slice) return { text };
    const onPage = toPageText(text, slice);
    // 這次收進來的（含拼接補收的）不再是等待中
    const result = (page: PageText) => {
      const waiting = waitingBoxes(cut, slice, [...collected, ...collectedBoxes(page)], column !== undefined);
      if (__DEBUG__ && cut.length > 0) trace('longPage:waiting', { anchorId: candidate.anchorId, cut: cut.length, waiting });
      return { text: page, ...(waiting.length > 0 ? { waiting } : {}) };
    };
    if (!column?.previous || cutTop.length + cutBottom.length === 0) return result(onPage);
    const stitched = await analyzeStitched({
      bitmap,
      viewport,
      candidate,
      rect,
      column: { ...column, previous: column.previous },
      cutTop,
      cutBottom,
      collected: [...collected, ...collectedBoxes(onPage)],
      notesNames,
    });
    return result(stitched ? mergePasses(onPage, stitched) : onPage);
  } finally {
    bitmap.close();
  }
}

/** 拼接那一次收到的 Line 接在這次的後面：id 與順序都錯開（transcriber 併進整個 Page 時會重編、依位置重排）。 */
function mergePasses(first: PageText, second: PageText): PageText {
  const offset = first.balloons.length + first.looseText.length;
  const shift = <T extends { id: string; order: number }>(t: T): T => ({ ...t, id: `${t.id}s`, order: t.order + offset });
  return { balloons: [...first.balloons, ...second.balloons.map(shift)], looseText: [...first.looseText, ...second.looseText.map(shift)] };
}

interface StitchRequest {
  bitmap: ImageBitmap;
  viewport: Size;
  candidate: PageCandidate;
  /** 這次整串看得到的範圍（截圖像素）。 */
  rect: Rect;
  column: { cutTop: boolean; cutBottom: boolean; previous: PreviousCapture };
  cutTop: Rows[];
  cutBottom: Rows[];
  /** 已收 Line 的外框（Page 座標），含這次剛收的。 */
  collected: RatioRect[];
  notesNames: string[];
}

/**
 * 被可見範圍邊緣切到的框（#282）：把同一串上一次的截圖接在這次被切的那一緣外面，在拼起來的圖上再辨識一次，
 * 只收跨過接縫的框（其他的這次或上次已經處理過）。回傳 Page 座標；兩次截圖接不起來時 undefined。
 */
async function analyzeStitched({ bitmap, viewport, candidate, rect, column, cutTop, cutBottom, collected, notesNames }: StitchRequest): Promise<PageText | undefined> {
  const { previous } = column;
  const { bitmap: before } = await decodeScreenshot(previous.screenshot, previous.viewport, previous.frameMark);
  try {
    // 視窗大小變了（開關 side panel）就不拼：兩張截圖的版面不同
    if (before.width !== bitmap.width || before.height !== bitmap.height) return undefined;
    const scale = bitmap.height / viewport.height;
    const region = toImageRect(previous.region, previous.viewport, before);
    if (Math.abs(region.x - rect.x) > 1 || Math.abs(region.width - rect.width) > 1) return undefined;
    const dy = Math.round(previous.dy * scale);
    const current = { top: rect.y, bottom: rect.y + rect.height };
    const stitch = stitchWindow(current, { top: region.y - dy, bottom: region.y + region.height - dy }, cutTop, cutBottom);
    if (!stitch) {
      trace('stitch:skip', { anchorId: candidate.anchorId, dy, current, previous: region });
      return undefined;
    }
    const { window, seam, edge } = stitch;
    const height = window.bottom - window.top;
    const canvas = new OffscreenCanvas(rect.width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    /** 視窗裡的一段列從某張截圖畫進來；那張截圖裡的 y 比這次的座標多 offset。 */
    const draw = (source: ImageBitmap, rows: Rows, offset: number) => {
      const h = rows.bottom - rows.top;
      if (h > 0) ctx.drawImage(source, rect.x, rows.top + offset, rect.width, h, 0, rows.top - window.top, rect.width, h);
    };
    draw(before, edge === 'top' ? { top: window.top, bottom: seam } : { top: seam, bottom: window.bottom }, dy);
    draw(bitmap, edge === 'top' ? { top: seam, bottom: window.bottom } : { top: window.top, bottom: seam }, 0);
    const stitched = canvas.transferToImageBitmap();
    try {
      const whole = { x: 0, y: 0, width: rect.width, height };
      const pageTop = candidate.rect.y * scale;
      const pageHeight = candidate.rect.height * scale;
      const slice: Slice = { top: (window.top - pageTop) / pageHeight, bottom: (window.bottom - pageTop) / pageHeight };
      const seamAt = (seam - window.top) / height;
      const margin = 2 / height;
      // 視窗最外面那一緣（上一次截圖的邊緣、或這次的另一緣）也被切的框，兩次截圖加起來還是看不完整
      const outer: SliceEdges =
        edge === 'top'
          ? { top: previous.cutTop, bottom: window.bottom >= current.bottom && column.cutBottom }
          : { top: window.top <= current.top && column.cutTop, bottom: previous.cutBottom };
      const rejected: { box: RatioRect; reason: string }[] = [];
      const accept = (box: RatioRect) => {
        // 沒跨過接縫的框不是這一次要補的
        if (box.y >= seamAt - margin || box.y + box.h <= seamAt + margin) return false;
        // 先看歸屬與重疊：已經收過的高框再出現時是 overlap，不是 tooTall
        const cut = cutEdges(box, height, outer);
        const reason = rejectInSlice(box, slice, height, collected, { top: false, bottom: false }) ?? (cut.top || cut.bottom ? 'tooTall' : undefined);
        if (reason) rejected.push({ box, reason });
        return reason === undefined;
      };
      const startedAt = performance.now();
      const analyzed = await pipeline.analyze(stitched, whole, { accept, notesNames });
      const rgba = pageRgba(stitched, whole);
      const text = { balloons: eraseBalloons(analyzed.balloons, rgba), looseText: eraseLoose(analyzed.looseText, rgba) };
      if (__DEBUG__) {
        trace('stitch', {
          anchorId: candidate.anchorId,
          edge,
          dy,
          window,
          seam,
          ms: Math.round(performance.now() - startedAt),
          rejected,
          balloons: text.balloons.map(({ id, 原文, ocrConfidence, balloonBbox }) => ({ id, 原文, ocrConfidence, balloonBbox })),
          looseText: text.looseText.map(({ id, 原文, ocrConfidence, bbox }) => ({ id, 原文, ocrConfidence, bbox })),
          detections: detectionImage(stitched, whole, text),
        });
      }
      return toPageText(text, slice);
    } finally {
      stitched.close();
    }
  } finally {
    before.close();
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
    const erase = eraseBalloon(page, ratioToBox(b.balloonBbox, page), text);
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

/** 猜作品原名（#186）：失敗由 SW 當成猜不出來。 */
async function guessSeries(input: TitleSignals, fake: FakeTranslatorConfig | undefined): Promise<SeriesGuessOutput> {
  if (__E2E__ && fake) return createFakeTranslator(SYNTHETIC_GROUND_TRUTH, fake).guessSeries(input);
  const translator = await claude();
  if (!translator) throw new NoApiKeyError('尚未設定 API key');
  trace('seriesGuess:request', { input });
  try {
    const output = await translator.guessSeries(input);
    trace('seriesGuess:response', { output });
    return output;
  } catch (e) {
    trace('seriesGuess:error', { error: e });
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
      (result) => sendResponse(result satisfies CropResponse),
      (e: unknown) => sendResponse({ error: String(e) } satisfies CropResponse),
    );
    return true;
  }
  if (message.type === 'offscreen:analyze') {
    analyze(message).then(
      (result) => sendResponse(result satisfies AnalyzeResponse),
      (e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) } satisfies AnalyzeResponse),
    );
    return true;
  }
  if (message.type === 'offscreen:kuromojiReadings') {
    createKuromojiReading(chrome.runtime.getURL('kuromoji/dict/')).then(
      (reading) => sendResponse({ readings: message.texts.map(reading) } satisfies KuromojiReadingsResponse),
      (e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) } satisfies KuromojiReadingsResponse),
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
  if (message.type === 'offscreen:guessSeries') {
    guessSeries(message.input, message.fake).then(
      (output) => sendResponse({ output } satisfies GuessSeriesResponse),
      (e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) } satisfies GuessSeriesResponse),
    );
    return true;
  }
  if (message.type === 'offscreen:prefetchModels') {
    if (__E2E__ && message.pipeline) pipeline.configure(message.pipeline);
    void pipeline.prefetch();
    return false;
  }
  if (message.type === 'offscreen:detectExecutionProvider') {
    void detectExecutionProvider().then(sendResponse);
    return true;
  }
  if (message.type === 'offscreen:testConnection') {
    testConnection().then(sendResponse);
    return true;
  }
  return false;
});
