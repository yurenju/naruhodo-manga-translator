/**
 * 一個 Page 上的文字：Balloon 與 Loose Text（spec #27 第 4.3 節的 balloons／looseText）。
 * 本機流水線（偵測＋OCR＋閱讀順序）產生座標、原文、順序；讀音與譯文來自 Translator，沒有時用 kuromoji 讀音。
 */
import type { Stripe } from './long-page.ts';
import type { TranslatedLine, UsedNote } from './translator.ts';

/**
 * 相對 Page 的 0～1 比例座標（ADR 0003）。跟 shared/messages.ts 的 Rect（畫面 CSS px）是不同東西，
 * 所以另外取名，也用 w／h 而不是 width／height。
 */
export interface RatioRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Orientation = 'vertical' | 'horizontal';

/** 擦除小圖（#149、#151）：image 是 box 大小的 PNG data URL（alpha＝擦除範圍），box 是它在 Page 上的位置。 */
export interface EraseData {
  box: RatioRect;
  image: string;
}

export interface BalloonText {
  id: string;
  /** 閱讀順序（本機決定），Balloon 與 Loose Text 共用同一串編號，從 1 開始。 */
  order: number;
  /** Balloon 外框（長字排版第 2 階段用）。沒有偵測到外框的 Balloon 等於 textBbox。 */
  balloonBbox: RatioRect;
  /** 文字框（擦除與排版用）。 */
  textBbox: RatioRect;
  orientation: Orientation;
  原文: string;
  讀音: string;
  讀音來源: 'llm' | 'kuromoji';
  /** 空字串＝未翻譯（沒有 API key 或還沒翻）。 */
  譯文: string;
  /** LLM 判斷是 OCR 亂碼，或 OCR 最低信心低於門檻（ADR 0009）：不覆蓋，side panel 列出原文。 */
  unreadable: boolean;
  /** OCR 非標點字的最低信心（ADR 0009）。舊快取沒有。 */
  ocrConfidence?: number;
  /** LLM 判斷是 Sound Effect（狀聲詞，GLOSSARY）。Balloon 不看這個欄位，照樣覆蓋。舊快取沒有。 */
  sfx?: boolean;
  /** 原地覆蓋的擦除底色：文字框（外擴 3px）裡最常出現的亮度 0～255，取自截圖（#32）。沒有時當白底。 */
  eraseLuminance?: number;
  /**
   * 擦除小圖（#149）：沿泡泡內緣的擦除範圍，顏色從背景內插。image 是 box 大小的 PNG data URL（alpha＝擦除範圍），
   * content script 原樣貼在 box 上。只存在本機快取，不送給 LLM 或 Worker。舊快取沒有、擦除退回矩形時也沒有：
   * 用文字框外擴 3px 的矩形加 eraseLuminance。
   * fit 是排版矩形（#150）：擦除範圍內面積最大的軸對齊矩形，譯文只排在這裡面。#150 之前算的小圖沒有，排版維持原本的範圍。
   */
  erase?: EraseData & { fit?: RatioRect };
}

export interface LooseText {
  id: string;
  order: number;
  bbox: RatioRect;
  orientation: Orientation;
  原文: string;
  讀音: string;
  讀音來源: 'llm' | 'kuromoji';
  譯文: string;
  unreadable: boolean;
  ocrConfidence?: number;
  /** LLM 判斷是 Sound Effect（狀聲詞，GLOSSARY）：不覆蓋，譯文只在 tooltip 與 side panel。舊快取沒有：整頁的 Loose Text 都不覆蓋。 */
  sfx?: boolean;
  /** 擦除範圍的平均亮度 0～255（#151）：低於 128 用白字。沒有擦除小圖時也拿來塗矩形。 */
  eraseLuminance?: number;
  /**
   * 擦除小圖（#151）：範圍限制在文字框＋padding 內，顏色從背景內插；跟 BalloonText.erase 同樣只存在本機快取。
   * 沒有時（備份還原的頁）用文字框外擴 3px 的矩形加 eraseLuminance。
   */
  erase?: EraseData;
}

export interface PageText {
  balloons: BalloonText[];
  looseText: LooseText[];
}

/**
 * 要原地覆蓋的段：有譯文、不是 unreadable（LLM 判斷亂碼或 OCR 信心低於門檻，ADR 0009）。Loose Text 還要 LLM
 * 明確說不是 Sound Effect（spec #142「Loose Text 原地覆蓋」）：舊快取沒有 sfx 就不蓋。Balloon 不管 sfx。
 */
export function overlaidTexts({ balloons, looseText }: PageText): PageText {
  const translated = (t: { unreadable: boolean; 譯文: string }) => !t.unreadable && t.譯文 !== '';
  return { balloons: balloons.filter(translated), looseText: looseText.filter((l) => translated(l) && l.sfx === false) };
}

/**
 * 只留在本機快取、不進備份的擦除資料（#149）。從截圖算出來的圖，備份只帶文字與座標；還原後那頁跟舊快取一樣
 * 退回矩形加 eraseLuminance。排版矩形（#150）在 erase 裡，跟著一起拿掉。之後新增的擦除資料加在這裡。
 */
const LOCAL_ERASE_KEYS = ['erase'] as const satisfies readonly (keyof BalloonText & keyof LooseText)[];

/** 拿掉一頁所有 Balloon 與 Loose Text 的擦除資料（不改到傳進來的物件）。 */
export function withoutEraseData<T extends PageText>(page: T): T {
  const strip = <U extends BalloonText | LooseText>(text: U): U => {
    const copy = { ...text };
    for (const key of LOCAL_ERASE_KEYS) delete copy[key];
    return copy;
  };
  return { ...page, balloons: page.balloons.map(strip), looseText: page.looseText.map(strip) };
}

/**
 * 已翻譯的一頁依閱讀順序的原文與譯文（Prior Pages 與 ② 的輸入，ADR 0005）。刻意跳過 unreadable（LLM 判斷亂碼或 OCR 信心
 * 低於門檻）：OCR 讀錯的字當上下文會誤導下一頁的翻譯，進 ② 會被整理成錯的 Notes 條目。
 */
export function pageLines({ balloons, looseText }: PageText): TranslatedLine[] {
  return [
    ...balloons.map((b) => ({ ...b, kind: 'balloon' as const })),
    ...looseText.map((l) => ({ ...l, kind: 'loose' as const })),
  ]
    .filter((t) => !t.unreadable)
    .sort((a, b) => a.order - b.order)
    .map(({ kind, 原文, 譯文 }) => ({ kind, 原文, 譯文 }));
}

/**
 * 長 Page 扣一個 Translated Page 的那次（spec #142「計費」）：Worker 回的 usageRecordId 與拿到它的時間。
 * 接續的截帶上 id，Worker 在 1 小時內只記用量、不再扣頁；超過就不帶，當成新的一頁扣。
 */
export interface PageCharge {
  usageRecordId: number;
  chargedAt: number;
}

/**
 * 只留在本機快取、不進備份的 Page 欄位：扣頁紀錄只對這個 Account、1 小時內有用，換台裝置還原也接不上。
 * 擦除資料另外在 LOCAL_ERASE_KEYS（在每個 Balloon／Loose Text 上）。
 */
const LOCAL_PAGE_KEYS = ['charge'] as const satisfies readonly (keyof PageTranslation)[];

/** 備份裡的一頁：拿掉只留在本機的欄位與擦除資料（不改到傳進來的物件）。 */
export function forBackup(page: PageTranslation): PageTranslation {
  const copy = withoutEraseData(page);
  for (const key of LOCAL_PAGE_KEYS) delete copy[key];
  return copy;
}

/**
 * 翻譯快取的一筆（spec #27 第 4.3 節）：key＝(seriesId, pageHash)。只存文字與座標，不存頁面圖片；
 * anchor 與 subRect 是畫面狀態，不進快取。
 */
export interface PageTranslation extends PageText {
  seriesId: string;
  /** shared/page-hash.ts 的 perceptual hash；查詢用 Hamming 距離門檻。長 Page 是第一次看到它時的身分，查詢不用它。 */
  pageHash: string;
  /** 長 Page（spec #142）才有：看過的橫條；查詢時任何一條對得上就命中。Line 是到目前收到的整個 Page。 */
  stripes?: Stripe[];
  /** 長 Page 用 Hosted Translation 翻過才有：扣頁那次的用量紀錄，之後的截接續時帶上。只在本機快取，不進備份。 */
  charge?: PageCharge;
  /** 判斷過時用（#38）。 */
  usedNotes: UsedNote[];
  model: string;
  promptVersion: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
  latencyMs: number;
  translatedAt: number;
}
