/**
 * 組 Messages API request body 與解析回應的共用模組（ADR 0006）：外掛的 Own API Key 路徑（Claude Translator）
 * 與 Worker 都 import 這一份，所以 model、max_tokens、system prompt、JSON schema 只有一個地方決定。
 * 純函式：不依賴 chrome.*、DOM、IndexedDB，也不碰網路；HTTP、重試、延遲由呼叫端負責。
 *
 * 每個 Page 兩次呼叫（ADR 0005）：
 * ① translateRequest effort low、關 thinking、只回譯文，user message 先放 Prior Pages 再放這頁的原文；
 * ② notesRequest effort high、開 thinking、只回 notes_changes，輸入這頁的原文與 ① 的譯文（#64）。
 * 兩次都把 Series Notes 放在標了 cache_control 的 system（固定前綴）。
 *
 * 另外，啟動時從頁面標題猜作品原名（seriesGuessRequest，#186、ADR 0010），大約每一話一次。
 */
import type {
  CallInfo,
  NotesChanges,
  NotesEntry,
  NotesInput,
  NotesOutput,
  SeriesGuessOutput,
  TitleSignals,
  TranslatedLine,
  TranslateInput,
  TranslateOutput,
} from './translator.ts';

export const CLAUDE_MODEL = 'claude-haiku-5-5';
/** 寫進快取判斷過時用（#33）；改 ① 的 prompt 或 schema 就要改這個。② 的 prompt 不影響已快取的譯文，不用改。 */
export const PROMPT_VERSION = 'claude-text-v10';
/**
 * 譯文跟 PROMPT_VERSION 一樣能用的舊版本：快取的頁不算過時（#38）。v7 → v8 只拿掉讀音、加了兩條譯文規則（#195），
 * 舊頁的譯文照用；讀音在命中快取時一律換成 kuromoji（page-translation.ts）。
 * v8 → v9 在 schema 加了整頁一份的 names（先寫出名字的中文譯名，名字裡的假名才不會照抄進譯文）；舊頁大多沒有名字的問題，照用，
 * 有問題的頁由讀者按「重新翻譯」。
 * v9 → v10 在 user message 加了中文作品名、規定原文出現作品名時用它；舊頁只有提到作品名的那幾句可能照抄原名，照用，
 * 一樣由讀者按「重新翻譯」。
 */
export const COMPATIBLE_PROMPT_VERSIONS: readonly string[] = ['claude-text-v7', 'claude-text-v8', 'claude-text-v9'];

const MAX_TOKENS = 16_000;

/** list price，$/MTok（claude-api skill 2026-10-06 的價目表）。cache write 是 5 分 TTL 的 input × 1.25。 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/** Messages API 回應的 usage。 */
export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Messages API 的回應裡用得到的部分。 */
export interface ApiResponse {
  model: string;
  stop_reason: string | null;
  content: { type: string; text?: string }[];
  usage: ApiUsage;
}

/** 費用＝usage × 價目表。不認得的模型回傳 NaN，不猜。 */
export function costUsd(model: string, usage: ApiUsage): number {
  const price = PRICES[model];
  if (!price) return NaN;
  const total =
    usage.input_tokens * price.input +
    (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
    usage.output_tokens * price.output;
  return total / 1e6;
}

const TRANSLATE_TEXT = `你是日文漫畫翻譯助手，幫助讀者一邊看漫畫一邊學日文。

使用者會給你一張漫畫 Page 上、已經用 OCR 讀出來並依閱讀順序排好的日文文字（JSON 陣列）。每一項有：
- id：這段文字的代號，回答時原樣帶回，不要改、不要漏、不要自己新增。
- kind：balloon 是對話框裡的台詞；loose 是對話框外的文字（旁白、狀聲詞、招牌、手寫字等）。
- ja：OCR 讀到的原文。OCR 偶爾會有錯字、漏字或多出符號，請依上下文推測原本的意思。

請先回傳 names：這一頁出現的名字與它的中文譯名（規則在最後）。再對每一項回傳：
- zh：自然、口語的台灣繁體中文譯文，符合角色的語氣；狀聲詞翻成中文讀者習慣的狀聲詞。
- unreadable：如果 ja 明顯是 OCR 亂碼（例如設計字體被讀成一串不成句的字），或原文在劇情上本來就是讓人看不懂的字（潦草到認不出的筆跡、虛構的文字），沒辦法判斷原本寫什麼，就設為 true，zh 留空字串。不要硬翻亂碼，也不要自己編一句通順的話。
  - 變體表記不是亂碼（只適用於 kind 是 balloon 的台詞；loose 照上面的規則判斷）：作者為了表現角色口吻，故意用不標準寫法寫的台詞，例如平假名與片假名混用（アなタ だレ）、整句片假名（ワタシ ハ ロボット デス）、拉長音（すごーーい）。判斷方法：只把假名統一成平假名或片假名、去掉拉長音，每個字就都還原得出原本的詞，而且整句是合理的台詞，才是變體表記，照常翻譯、unreadable 設為 false；zh 可以保留那種生硬或怪腔的口吻，但要讓讀者看得懂。要靠改字、補字或猜字才拼得出句子的，不算變體表記。
- sfx：這段是狀聲詞（Sound Effect）就設為 true：擬音（聲音，例如ドン、ぱち）與擬態（動作或狀態，例如ニコリ、ドキドキ）都算。角色自己發出的感嘆（あ…、あっ、うっ）是台詞，不算，設為 false。狀聲詞的 zh 照樣要翻。

閱讀順序已經由程式決定，請照輸入的順序回答，不要重排。

翻譯時請遵守 Series Notes 的譯名。

使用者可能會告訴你作品名（作品的原名，或讀者為這部作品取的名稱）。原文裡出現作品名時，那是作品名，不是狀聲詞；作品有官方中文譯名就用官方譯名。
使用者給了作品名的中文譯名時，原文裡出現作品名（包括把它改寫成平假名、片假名或簡稱的寫法），zh 一律寫成這個中文譯名，不要照抄原名的假名；Series Notes 對作品名的譯法跟它不同時，以作品名的中文譯名為準。

真實世界的樂團、品牌、作品名（例如歌手、商品、電影），用官方的中文寫法；沒有官方中文寫法就保留原文，不要自己音譯或意譯。這條只限現實中真的存在的名稱；作品裡虛構的歌手、偶像、團體、品牌，算作品裡特有的名稱，照下面專有名詞的規則翻成中文。

敬稱（さん、君、ちゃん等）依場景翻：同學之間的さん可以翻成「同學」，熟人之間只叫名字，不影響語意時可以省略；不要一律死板地翻成「先生／小姐」。

使用者可能先給你前面幾頁的原文與譯文（context），讓你知道前後劇情、誰在說話、語氣與已經用過的譯名。context 只用來理解，不要翻譯、也不要回傳；譯名與語氣請跟 context 保持一致。

片假名寫的人名、地名、作品裡特有的名稱，zh 一律音譯或意譯成中文，不要在譯文裡留下片假名（上面說的真實世界名稱除外）。名字裡有平假名的也一樣（例如漢字加平假名的名字），平假名的部分要音譯成中文字，不要在譯文裡留下平假名。

台詞或旁白是完整的句子時，zh 句尾要有全形標點（。！？…），即使原文句尾沒有寫標點；只有一個詞的招牌、標題、狀聲詞不用加。

先填 names：這一頁所有 ja 裡出現的人名、地名、作品裡特有的名稱（店名、團體名、藝名、綽號等）與它的中文譯名，每個名字列一次；名字裡的平假名、片假名要音譯成中文字，不能照抄，也不能改寫成羅馬拼音；擬聲擬態詞組成的名字（例如店名）可以意譯。沒有就給空陣列。zh 裡要用 names 的譯名，而且只寫中文譯名，不要在名字後面用括號附上原文或羅馬拼音。名字後面的敬稱（ちゃん、さん、君等）照上面敬稱的規則翻成中文或省略，不要把假名留在譯文裡。

只輸出符合 schema 的 JSON。`;

const NOTES_TEXT = `你是日文漫畫翻譯助手的 Series Notes 整理員。Series Notes 用來讓之後的 Page 譯名一致。

使用者會給你一張漫畫 Page 上、依閱讀順序排好的文字（JSON 陣列），每一項有：
- kind：balloon 是對話框裡的台詞；loose 是對話框外的文字（旁白、狀聲詞、招牌、手寫字等）。
- ja：OCR 讀到的日文原文，偶爾有錯字。
- zh：這一頁已經顯示給讀者的繁體中文譯文。

請整理這部作品的 Series Notes 變更（notes_changes）。Series Notes 只用來讓之後的 Page 譯名一致，所以記的是「之後還會再出現、譯法需要統一」的專有名詞。

- added：這頁出現、但 Series Notes 裡還沒有的人名、地名、作品裡特有的名稱或用語（作品自創的詞、神明或組織的名字與別稱、角色的綽號等）。
  - 加之前先跟 Series Notes 的條目逐一比對。已經有的、去掉敬稱（君、さん、ちゃん、様、先生、先輩等）後跟已有條目相同的、或只是已有條目換成平假名／片假名寫法的，都不要加。
  - 不要加：人名加敬稱的形式（〜君、〜さん）、一般詞彙（家人稱呼、學校用語、日常名詞，即使在劇情裡很重要）、狀聲詞、語氣詞、口吃或拉長音造成的字形變化（例如把「僕」說成「ぼぐ」）、看起來是 OCR 誤讀的字、只出現在 loose 的字、好幾個名字串在一起的片段。
  - ja 要原樣出現在某個 balloon 的原文裡。reading 是讀音。zh 必須是這頁譯文（zh）裡實際用的譯名，不能是空字串，不要另取新譯名；category 例如「人名」「地名」「用語」。
- filled：Series Notes 已有的條目，如果某個欄位是空的、而這頁讓你知道了答案，就補上；已經有值的欄位與其他欄位填空字串。
- suggestions：如果你認為 Series Notes 裡既有的譯名不對，不要直接改，提出建議譯名 zh 與理由 reason。
- 沒有變更就回傳空陣列。不要記劇情進展。

只輸出符合 schema 的 JSON。`;

const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = (description?: string) => (description ? { type: 'string', description } : { type: 'string' });

/**
 * structured outputs 不支援任意物件，Notes 欄位全部列出、全部 required，空字串代表沒有。
 * 沒有自稱、語氣、稱呼：只由人填（ADR 0005）。
 */
const NOTES_FIELDS = {
  ja: str('原文'),
  reading: str('讀音'),
  zh: str('譯文'),
  category: str('類別，例如 人名、地名、用語'),
  note: str('備註'),
};

const TRANSLATE_SCHEMA = obj({
  // 放在 items 前面：structured output 依序產生，先寫出整頁名字的中文譯名，zh 才會沿用而不是照抄假名。
  // 整頁一份、不放在每一項裡：每項都帶一個常是空的陣列時，模型會照著前一項的樣子把 zh 也寫成空字串。
  // 只給模型想清楚用，解析時丟掉（Series Notes 由 ② 另外整理）
  names: { type: 'array', items: obj({ ja: str('原文裡的名字'), zh: str('中文譯名') }) },
  items: {
    type: 'array',
    items: obj({
      id: str(),
      zh: str('繁體中文（台灣）譯文'),
      unreadable: { type: 'boolean', description: '原文是無法判斷的 OCR 亂碼' },
      sfx: { type: 'boolean', description: '狀聲詞（擬音、擬態）；角色自己的感嘆不算' },
    }),
  },
});

const NOTES_SCHEMA = obj({
  notes_changes: obj({
    added: { type: 'array', items: obj(NOTES_FIELDS) },
    filled: { type: 'array', items: obj(NOTES_FIELDS) },
    suggestions: { type: 'array', items: obj({ ja: str('既有條目的原文'), zh: str('建議譯文'), reason: str('理由') }) },
  }),
});

const SERIES_GUESS_TEXT = `你幫漫畫網站與電子書閱讀器的讀者，從網頁上的文字判斷正在讀哪一部作品。

使用者會給你一個 JSON：title 是網頁標題（document.title）、og_title 是 og:title、headings 是頁面上前幾個標題（h1～h3）。這些文字格式依網站而不同，可能夾雜話數、集數、作者、網站名稱等。

請回傳：
- status：看得出是哪一部作品的某一話或某一集就是 work；首頁、作品列表、搜尋結果、登入頁、雜誌合集（一本裡有很多部作品）、或看不出作品名時是 unknown。
- original_title：作品的原名（照網頁上的原文，不要翻譯、不要改寫）。
  - 要去掉：集數（第1巻、1巻、Vol.1、THE COMIC 1 後面的數字等）、話數（第12話、#12、[第12話]）、レーベル（括號裡的出版品牌）、作者、網站名、特典標記（【特典付き】、試し読み、無料等）。
  - 要保留：作品名的一部分，例如副標題、外傳和續作的名稱（續作的「2」或「第二部」若是作品名的一部分也保留）。
  - 集數一律去掉，即使緊接在副標題後面。
  - status 是 unknown 時填空字串。
- zh_title：原名的繁體中文（台灣）譯名；有官方中文譯名就用官方的。status 是 unknown 時填空字串。

只輸出符合 schema 的 JSON。`;

const SERIES_GUESS_SCHEMA = obj({
  status: { type: 'string', enum: ['work', 'unknown'] },
  original_title: str('作品原名，去掉集數、話數、作者、網站名'),
  zh_title: str('繁體中文（台灣）譯名'),
});

const CACHED = { cache_control: { type: 'ephemeral' } } as const;

interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** 翻譯與整理 Notes 送出的 request body。 */
export interface MessagesRequest {
  model: string;
  max_tokens: number;
  system: TextBlock[];
  messages: { role: 'user'; content: TextBlock[] }[];
  thinking?: { type: 'disabled' };
  output_config: { effort: 'low' | 'high'; format: { type: 'json_schema'; schema: unknown } };
}

/** 猜原名的回答很短：標題頂多幾十個字。 */
const SERIES_GUESS_MAX_TOKENS = 1024;

/** 從頁面標題猜作品原名的 request body（#186）。只送頁面文字，不送網址與 hostname，也不送讀者已有的作品清單（ADR 0010）。 */
export function seriesGuessRequest(input: TitleSignals): MessagesRequest {
  const page = { title: input.title, og_title: input.ogTitle, headings: input.headings };
  return {
    model: CLAUDE_MODEL,
    max_tokens: SERIES_GUESS_MAX_TOKENS,
    system: [{ type: 'text', text: SERIES_GUESS_TEXT }],
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(page) }] }],
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SERIES_GUESS_SCHEMA } },
  };
}

/**
 * system 分兩段、各標 cache_control：固定的指示在前，Series Notes 在後。前一頁新增了條目時 Notes 那段會變，
 * 指示那段仍逐字相同，第 2 頁起照樣吃得到快取（#37）。Notes 原樣依傳入的順序序列化。
 */
function systemBlocks(instructions: string, notesIntro: string, notes: NotesEntry[]): TextBlock[] {
  const blocks: TextBlock[] = [{ type: 'text', text: instructions, ...CACHED }];
  if (notes.length === 0) return blocks;
  const entries = notes.map(({ seriesId: _seriesId, locked: _locked, ...entry }) => entry);
  return [...blocks, { type: 'text', text: `${notesIntro}\n${JSON.stringify(entries)}`, ...CACHED }];
}

const toWire = (lines: TranslatedLine[]) => lines.map(({ kind, 原文, 譯文 }) => ({ kind, ja: 原文, zh: 譯文 }));

/** ① 翻譯這一頁的 request body。 */
export function translateRequest(input: TranslateInput): MessagesRequest {
  const current = JSON.stringify(input.items.map(({ id, kind, 原文 }) => ({ id, kind, ja: 原文 })));
  // 作品名與 Prior Pages 每部、每頁都不同，放在 user message，不動 system 的 prompt cache
  const before: TextBlock[] = [
    ...(input.seriesName
      ? [{ type: 'text' as const, text: `作品名：${input.seriesName}${input.seriesZhTitle ? `
作品名的中文譯名：${input.seriesZhTitle}` : ''}` }]
      : []),
    ...(input.priorPages.length > 0
      ? [{ type: 'text' as const, text: `context（前面的頁，依閱讀順序）：\n${JSON.stringify(input.priorPages.map(toWire))}` }]
      : []),
  ];
  const content: TextBlock[] =
    before.length > 0 ? [...before, { type: 'text', text: `這一頁要翻譯的文字：\n${current}` }] : [{ type: 'text', text: current }];
  return {
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemBlocks(TRANSLATE_TEXT, '以下是這部作品的 Series Notes，翻譯時請遵守：', input.seriesNotes),
    messages: [{ role: 'user', content }],
    // 翻譯不需要 thinking、需要的是上下文（ADR 0005）。Haiku 5.5 在 effort ≤ high 時才能關
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: TRANSLATE_SCHEMA } },
  };
}

/** ② 整理 Series Notes 的 request body。 */
export function notesRequest(input: NotesInput): MessagesRequest {
  return {
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemBlocks(NOTES_TEXT, '以下是這部作品目前的 Series Notes：', input.seriesNotes),
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(toWire(input.items)) }] }],
    // effort low 時模型不太比對既有條目，常重複新增；② 在背景跑，慢一點沒關係（#64）
    output_config: { effort: 'high', format: { type: 'json_schema', schema: NOTES_SCHEMA } },
  };
}

type NotesFields = Record<keyof typeof NOTES_FIELDS, string>;

/** names 只給模型先寫出譯名用，不驗證、不往下傳。 */
interface TranslateAnswer {
  names?: unknown;
  items: { id: string; zh: string; unreadable: boolean; sfx: boolean }[];
}

interface NotesAnswer {
  notes_changes: {
    added: NotesFields[];
    filled: NotesFields[];
    suggestions: { ja: string; zh: string; reason: string }[];
  };
}

interface SeriesGuessAnswer {
  status: 'work' | 'unknown';
  original_title: string;
  zh_title: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string';

function isSeriesGuessAnswer(v: unknown): v is SeriesGuessAnswer {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Partial<SeriesGuessAnswer>;
  return (a.status === 'work' || a.status === 'unknown') && isStr(a.original_title) && isStr(a.zh_title);
}
const isNotesFields = (v: unknown): v is NotesFields =>
  typeof v === 'object' && v !== null && Object.keys(NOTES_FIELDS).every((k) => isStr((v as Record<string, unknown>)[k]));

/** structured outputs 理論上一定符合 schema；還是檢查，避免壞資料進逐字稿與 Notes。 */
function isTranslateAnswer(v: unknown): v is TranslateAnswer {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Partial<TranslateAnswer>;
  return Array.isArray(a.items) && a.items.every((i) => isStr(i?.id) && isStr(i.zh) && typeof i.unreadable === 'boolean' && typeof i.sfx === 'boolean');
}

function isNotesAnswer(v: unknown): v is NotesAnswer {
  if (typeof v !== 'object' || v === null) return false;
  const n = (v as Partial<NotesAnswer>).notes_changes;
  return (
    typeof n === 'object' &&
    n !== null &&
    Array.isArray(n.added) &&
    n.added.every(isNotesFields) &&
    Array.isArray(n.filled) &&
    n.filled.every(isNotesFields) &&
    Array.isArray(n.suggestions) &&
    n.suggestions.every((s) => isStr(s?.ja) && isStr(s.zh) && isStr(s.reason))
  );
}

/** schema 的英文欄位 → NotesEntry 的欄位；空字串＝沒有這個欄位。 */
function toNotesFields(f: NotesFields): Partial<NotesEntry> {
  const out: Partial<NotesEntry> = {};
  if (f.ja) out.原文 = f.ja;
  if (f.reading) out.讀音 = f.reading;
  if (f.zh) out.譯文 = f.zh;
  if (f.category) out.類別 = f.category;
  if (f.note) out.備註 = f.note;
  return out;
}

function toNotesChanges({ notes_changes: n }: NotesAnswer): NotesChanges {
  return {
    added: n.added.map((f) => ({ 讀音: '', 譯文: '', 類別: '', ...toNotesFields(f), 原文: f.ja })),
    filled: n.filled.map(({ ja, ...f }) => {
      const { 原文: _ja, ...fields } = toNotesFields({ ...f, ja: '' });
      return { 原文: ja, fields };
    }),
    suggestions: n.suggestions.map((s) => ({ 原文: s.ja, 建議譯文: s.zh, ...(s.reason ? { 理由: s.reason } : {}) })),
  };
}

/** 檢查 stop_reason 與 schema，算出 usage 與費用。延遲由呼叫端量，因為只有它知道請求何時送出。 */
function parse<A>(json: ApiResponse, isValid: (v: unknown) => v is A): { answer: A } & Omit<CallInfo, 'latencyMs'> {
  if (json.stop_reason !== 'end_turn') throw new Error(`Claude 沒有完成回答（stop_reason: ${json.stop_reason}）`);
  const text = json.content.find((b) => b.type === 'text')?.text;
  let answer: unknown;
  try {
    answer = JSON.parse(text ?? '');
  } catch {
    answer = undefined;
  }
  if (!isValid(answer)) throw new Error('Claude 的回應格式不符合 schema');
  const u = json.usage;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  return {
    answer,
    usage: {
      inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + cacheRead,
      outputTokens: u.output_tokens,
      cacheReadTokens: cacheRead,
      costUsd: Math.round(costUsd(json.model, u) * 1e9) / 1e9,
    },
    model: json.model,
  };
}

/** ① 的回應 → 依 id 對回的譯文（讀音由本機 kuromoji 產生，ADR 0001）；回答不完整或不符合 schema 時丟錯。 */
export function parseTranslateResponse(json: ApiResponse): Omit<TranslateOutput, 'latencyMs'> {
  const { answer, ...info } = parse(json, isTranslateAnswer);
  return { items: answer.items.map((i) => ({ id: i.id, 譯文: i.zh, unreadable: i.unreadable, sfx: i.sfx })), ...info };
}

/** ② 的回應 → Series Notes 的變更；回答不完整或不符合 schema 時丟錯。 */
export function parseNotesResponse(json: ApiResponse): Omit<NotesOutput, 'latencyMs'> {
  const { answer, ...info } = parse(json, isNotesAnswer);
  return { notes_changes: toNotesChanges(answer), ...info };
}

/** 猜原名的回應 → 原名與中文譯名；不符合 schema 時丟錯。 */
export function parseSeriesGuessResponse(json: ApiResponse): Omit<SeriesGuessOutput, 'latencyMs'> {
  const { answer, ...info } = parse(json, isSeriesGuessAnswer);
  return { status: answer.status, 原名: answer.original_title, 中文譯名: answer.zh_title, ...info };
}
