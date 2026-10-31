/**
 * 可替換的 LLM 呼叫介面（spec #27 第 5 節）。v1 的正式實作是 Claude（#31）；
 * e2e 用 FakeTranslator（spec 第 12 節）。LLM 只看文字，永遠不提供座標、不改閱讀順序（ADR 0001）。
 * 一頁分兩次呼叫（ADR 0005）：① translatePage 只回譯文；② proposeNotes 在背景整理 Series Notes。
 */
import type { Orientation } from './page-text.ts';

/** Series Notes 的一個條目（spec 第 4.2 節）。 */
export interface NotesEntry {
  seriesId: string;
  原文: string;
  讀音: string;
  譯文: string;
  類別: string;
  備註?: string;
  locked: boolean;
  /** 自稱、語氣、稱呼只由人在 side panel 填（ADR 0005：LLM 只看文字，會填到錯的角色身上）。 */
  自稱?: string;
  語氣?: string;
  稱呼?: string;
}

/** 一頁翻譯時用到的條目：當時的原文與譯文（快取的 usedNotes，#38 判斷過時用）。 */
export type UsedNote = Pick<NotesEntry, '原文' | '譯文'>;

/** Prior Pages 裡的一句（GLOSSARY）：不送讀音，unreadable 的不送。 */
export interface TranslatedLine {
  kind: 'balloon' | 'loose';
  原文: string;
  譯文: string;
}

/** 這部 Series 在目前這批之前最近看過、已經翻好的頁，依讀者看過的順序（舊的在前）。 */
export type PriorPage = TranslatedLine[];

export interface TranslateInput {
  /** 讀者為 Series 取的名稱；Provisional Series 的名稱是自動產生的，不送。 */
  seriesName?: string;
  /** v1 整份送。 */
  seriesNotes: NotesEntry[];
  /** 只用來理解前後文，不翻譯（ADR 0005）。 */
  priorPages: PriorPage[];
  /** 依閱讀順序。 */
  items: {
    id: string;
    kind: 'balloon' | 'loose';
    原文: string;
    orientation: Orientation;
  }[];
  /**
   * 只有 Hosted Translation 的長 Page 接續請求有（spec #142「計費」）：同一個 Page 前一次 ① 的 TranslateOutput.usageRecordId，
   * Worker 在條件內只記用量、不扣頁（不進 prompt）。
   */
  pageUsageRecordId?: number;
}

/** ② 的輸入：這一頁的原文與 ① 的譯文（unreadable 的不送）。 */
export interface NotesInput {
  seriesNotes: NotesEntry[];
  /** 依閱讀順序。 */
  items: TranslatedLine[];
  /** 只有 Hosted Translation 有：同一頁 ① 的 TranslateOutput.usageRecordId，Worker 用它把 Notes 的用量歸到這一頁（不進 prompt）。 */
  pageUsageRecordId?: number;
}

/** LLM 對 Series Notes 的變更：新增／補空欄位／建議修改。套用規則在 series-notes.ts（SW 執行）。 */
export interface NotesChanges {
  added: Omit<NotesEntry, 'seriesId' | 'locked'>[];
  /** 補既有條目的空欄位。 */
  filled: { 原文: string; fields: Partial<NotesEntry> }[];
  /** 想改既有條目的譯文。 */
  suggestions: { 原文: string; 建議譯文: string; 理由?: string }[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** 一次 LLM 呼叫的花費與模型。 */
export interface CallInfo {
  usage: Usage;
  model: string;
  latencyMs: number;
}

export interface TranslateOutput extends CallInfo {
  /** sfx：LLM 判斷是 Sound Effect（#151）。部署中的舊版 Worker 不回，當成不知道（Loose Text 不覆蓋）。 */
  items: { id: string; 讀音: string; 譯文: string; unreadable: boolean; sfx?: boolean }[];
  /**
   * 只有 Hosted Translation 有：這一頁扣頁的那次翻譯的用量紀錄 id（接續請求回的是被接續的那筆）。同一頁的 Notes 請求、
   * 長 Page 的接續請求帶回去（NotesInput／TranslateInput 的 pageUsageRecordId）。
   */
  usageRecordId?: number;
}

export interface NotesOutput extends CallInfo {
  notes_changes: NotesChanges;
}

export interface Translator {
  /** ①：只回譯文。 */
  translatePage(input: TranslateInput, signal?: AbortSignal): Promise<TranslateOutput>;
  /** ②：只回 notes_changes；條目的譯名照抄這頁譯文裡用的。 */
  proposeNotes(input: NotesInput, signal?: AbortSignal): Promise<NotesOutput>;
}
