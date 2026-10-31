/**
 * client 送來的 body → TranslateInput／NotesInput。只取已知欄位、檢查型別，其他欄位（model、max_tokens、system、
 * Notes 條目裡多出來的 key）一律丟掉：Notes 條目會原樣序列化進 system prompt，不能讓 client 塞任意欄位（ADR 0006）。
 * 格式不對回 undefined（Worker 回 400）。
 */
import type { NotesEntry, NotesInput, PriorPage, TranslatedLine, TranslateInput } from '../../src/shared/translator.ts';

type Item = TranslateInput['items'][number];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isKind = (v: unknown): v is Item['kind'] => v === 'balloon' || v === 'loose';

/** 每一項都轉得過才回傳陣列。 */
function all<T>(v: unknown, convert: (x: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const x of v) {
    const converted = convert(x);
    if (converted === undefined) return undefined;
    out.push(converted);
  }
  return out;
}

function item(v: unknown): Item | undefined {
  if (!isObject(v) || !isString(v.id) || !isKind(v.kind) || !isString(v.原文)) return undefined;
  if (v.orientation !== 'vertical' && v.orientation !== 'horizontal') return undefined;
  return { id: v.id, kind: v.kind, 原文: v.原文, orientation: v.orientation };
}

function line(v: unknown): TranslatedLine | undefined {
  if (!isObject(v) || !isKind(v.kind) || !isString(v.原文) || !isString(v.譯文)) return undefined;
  return { kind: v.kind, 原文: v.原文, 譯文: v.譯文 };
}

const priorPage = (v: unknown): PriorPage | undefined => all(v, line);

const OPTIONAL_NOTE_FIELDS = ['備註', '自稱', '語氣', '稱呼'] as const;

function note(v: unknown): NotesEntry | undefined {
  if (!isObject(v) || !isString(v.seriesId) || typeof v.locked !== 'boolean') return undefined;
  if (!isString(v.原文) || !isString(v.讀音) || !isString(v.譯文) || !isString(v.類別)) return undefined;
  const entry: NotesEntry = { seriesId: v.seriesId, 原文: v.原文, 讀音: v.讀音, 譯文: v.譯文, 類別: v.類別, locked: v.locked };
  for (const field of OPTIONAL_NOTE_FIELDS) {
    const value = v[field];
    if (value === undefined) continue;
    if (!isString(value)) return undefined;
    entry[field] = value;
  }
  return entry;
}

/** 作品名是讀者打的 Series 名稱，會原樣放進 user message；比這長的不是作品名。 */
const MAX_SERIES_NAME = 200;

export function parseTranslateInput(body: unknown): TranslateInput | undefined {
  if (!isObject(body)) return undefined;
  const { seriesName } = body;
  if (seriesName !== undefined && !(isString(seriesName) && seriesName.length <= MAX_SERIES_NAME)) return undefined;
  const seriesNotes = all(body.seriesNotes, note);
  const priorPages = all(body.priorPages, priorPage);
  const items = all(body.items, item);
  if (!seriesNotes || !priorPages || !items) return undefined;
  // 接續哪一頁只影響扣不扣頁，不對就當作沒帶（照常扣）
  const page = body.pageUsageRecordId;
  return {
    ...(seriesName === undefined ? {} : { seriesName }),
    seriesNotes,
    priorPages,
    items,
    ...(Number.isSafeInteger(page) ? { pageUsageRecordId: page as number } : {}),
  };
}

export function parseNotesInput(body: unknown): NotesInput | undefined {
  if (!isObject(body)) return undefined;
  const seriesNotes = all(body.seriesNotes, note);
  const items = all(body.items, line);
  if (!seriesNotes || !items) return undefined;
  // 歸屬哪一頁只影響用量紀錄，不對就當作沒帶，Notes 照常整理
  const page = body.pageUsageRecordId;
  return { seriesNotes, items, ...(Number.isSafeInteger(page) ? { pageUsageRecordId: page as number } : {}) };
}
