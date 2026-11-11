import { describe, expect, it } from 'vitest';
import type { Quota, RefundInfo } from '../shared/hosted-api.ts';
import type { PageView } from '../shared/messages.ts';
import type { RatioRect } from '../shared/page-text.ts';
import type { TranslationMode } from '../shared/translation-mode.ts';
import type { SeriesOption } from '../shared/series.ts';
import { accountPageView, accountPlanView, canTranslate, parentPage, quotaView, seriesActions, refundDialogView, setupNotices, sidePanelScreen, sidePanelView, translateAction, type SubscribedQuota } from './view.ts';

type Transcript = PageView['transcript'];
type Done = Extract<Transcript, { state: 'done' }>;

const TEXT = { balloons: [], looseText: [] };

/** 翻譯好的一頁；info 是狀態列要顯示的模型・毫秒・費用。 */
function translated(info: { model?: string; latencyMs?: number; costUsd?: number; source?: 'translated' | 'cache' } = {}): Done {
  const { model = 'claude-x', latencyMs = 1000, costUsd = 0.001, source = 'translated' } = info;
  return {
    state: 'done',
    text: TEXT,
    translated: true,
    translation: { model, latencyMs, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd }, source },
  };
}

function page(pageHash: string, anchorId: string, extra: { subRect?: RatioRect; transcript?: Transcript } = {}): PageView {
  return {
    anchorId,
    rect: { x: 0, y: 0, width: 800, height: 600 },
    thumbnail: '',
    pageHash,
    transcript: { state: 'analyzing' },
    ...extra,
  };
}

/** Spread 切開的左半與右半（anchor 寬度的比例）。 */
const LEFT_HALF: RatioRect = { x: 0, y: 0, w: 0.5, h: 1 };
const RIGHT_HALF: RatioRect = { x: 0.5, y: 0, w: 0.5, h: 1 };

const listed = (pages: PageView[]) => sidePanelView(pages, 'ownKey').pages.map((p) => [p.page.pageHash, p.side, p.heading]);

describe('side panel 的 Page 清單', () => {
  it('單頁照 SW 的順序，頁首是「第 N 頁」、不標左右', () => {
    expect(listed([page('p1', 'a1'), page('p2', 'a2')])).toEqual([
      ['p1', undefined, { title: '第 1 頁' }],
      ['p2', undefined, { title: '第 2 頁' }],
    ]);
  });

  const RIGHT_FIRST = [
    ['right', 'right', { title: '右頁', order: '先讀' }],
    ['left', 'left', { title: '左頁', order: '後讀' }],
  ];

  it('同一個 anchor 切出兩個 Page 是 Spread：右頁在前，頁首「右頁 · 先讀」「左頁 · 後讀」', () => {
    expect(listed([page('right', 'a1', { subRect: RIGHT_HALF }), page('left', 'a1', { subRect: LEFT_HALF })])).toEqual(RIGHT_FIRST);
  });

  it('SW 給的 Spread 順序是左頁在前，仍排成右頁在前', () => {
    expect(listed([page('left', 'a1', { subRect: LEFT_HALF }), page('right', 'a1', { subRect: RIGHT_HALF })])).toEqual(RIGHT_FIRST);
  });

  it('去黑邊的單頁（有 subRect、中心偏右）仍是「第 N 頁」，不是右頁', () => {
    const trimmed: RatioRect = { x: 0.3, y: 0, w: 0.5, h: 1 };
    expect(listed([page('p1', 'a1', { subRect: trimmed })])).toEqual([['p1', undefined, { title: '第 1 頁' }]]);
  });

  it('同一個 anchor 的兩個 Page 沒有 subRect：分不出左右，照 SW 的順序、頁首「第 N 頁」', () => {
    expect(listed([page('p1', 'a1'), page('p2', 'a1')])).toEqual([
      ['p1', undefined, { title: '第 1 頁' }],
      ['p2', undefined, { title: '第 2 頁' }],
    ]);
  });
});

const pageStatus = (transcript: Transcript, mode: TranslationMode = 'ownKey') => sidePanelView([page('p1', 'a1', { transcript })], mode).pages[0]!.translationStatus;

describe('單頁的翻譯狀態列', () => {
  it('新翻譯：「已翻譯」・模型・秒數・費用', () => {
    expect(pageStatus(translated({ model: 'claude-x', latencyMs: 2345, costUsd: 0.01234 }))).toBe('已翻譯・claude-x・2.3 秒・$0.0123');
  });

  it('快取：「快取」・當初翻譯的模型與數字', () => {
    expect(pageStatus(translated({ model: 'claude-y', latencyMs: 800, costUsd: 0.002, source: 'cache' }))).toBe('快取・claude-y・0.8 秒・$0.0020');
  });

  it('內建翻譯：只有「已翻譯」或「快取」與秒數，不顯示模型與費用', () => {
    expect(pageStatus(translated({ model: 'claude-x', latencyMs: 2345 }), 'hosted')).toBe('已翻譯・2.3 秒');
    expect(pageStatus(translated({ latencyMs: 800, source: 'cache' }), 'hosted')).toBe('快取・0.8 秒');
  });

  it('還在辨識、正在翻譯、翻譯失敗時不顯示', () => {
    expect(pageStatus({ state: 'analyzing' })).toBeUndefined();
    expect(pageStatus({ ...translated(), translating: true })).toBeUndefined();
    expect(pageStatus({ ...translated(), translateError: 'boom' })).toBeUndefined();
  });
});

const overall = (transcripts: Transcript[], mode: TranslationMode = 'ownKey') =>
  sidePanelView(transcripts.map((transcript, i) => page(`p${i}`, `a${i}`, { transcript })), mode).status;

describe('底部的整體狀態列', () => {
  it('多個 Page 時加總頁數、秒數、費用', () => {
    expect(
      overall([translated({ latencyMs: 1200, costUsd: 0.00123 }), translated({ latencyMs: 2300, costUsd: 0.00456 })]),
    ).toEqual({ kind: 'summary', text: '已翻譯 2 頁 · claude-x · 3.5 秒 · $0.00579' });
  });

  it('內建翻譯：只有頁數與秒數，不顯示模型與費用', () => {
    expect(overall([translated({ latencyMs: 3000 }), translated({ latencyMs: 4700 })], 'hosted')).toEqual({ kind: 'summary', text: '已翻譯 2 頁 · 7.7 秒' });
  });

  it('多個模型用「、」列出，同一個模型只列一次', () => {
    expect(overall([translated({ model: 'm1' }), translated({ model: 'm2' }), translated({ model: 'm1' })])).toMatchObject({
      text: expect.stringContaining('已翻譯 3 頁 · m1、m2 · '),
    });
  });

  it('有一頁的 Series Notes 過時：開頭加「角色與用語已更新」（UI 名稱，#186）', () => {
    expect(overall([{ ...translated({ latencyMs: 1000, costUsd: 0.001 }), stale: 'notes' }])).toEqual({
      kind: 'summary',
      text: '角色與用語已更新 · 已翻譯 1 頁 · claude-x · 1.0 秒 · $0.00100',
    });
  });

  it('只算有譯文的頁；快取的頁也算進去', () => {
    const kuromojiOnly: Transcript = { state: 'done', text: TEXT, translated: false };
    expect(overall([translated({ source: 'cache' }), kuromojiOnly, { state: 'analyzing' }])).toMatchObject({
      text: expect.stringMatching(/^已翻譯 1 頁 · /),
    });
  });

  it('有一頁正在翻譯：顯示「翻譯中」', () => {
    expect(overall([translated(), { ...translated(), translating: true }])).toEqual({ kind: 'translating' });
  });

  it('沒有任何譯文時不顯示', () => {
    expect(overall([])).toBeUndefined();
    expect(overall([{ state: 'analyzing' }, { state: 'done', text: TEXT, translated: false }])).toBeUndefined();
  });

  it('費用算不出來時顯示「費用未知」', () => {
    expect(overall([translated({ costUsd: Number.NaN })])).toMatchObject({ text: expect.stringMatching(/ · 費用未知$/) });
  });
});

describe('翻譯前的設定提示', () => {
  it('內建翻譯、沒登入：顯示「尚未登入」，即使還沒有頁；不顯示資料使用說明卡（同意在登入時取得）', () => {
    expect(setupNotices({ access: { mode: 'hosted', signedIn: false }, consented: false, untranslated: false })).toEqual({
      consentCard: false,
      notice: 'signedOut',
    });
  });

  it('內建翻譯、已登入而且同意了：什麼都不顯示', () => {
    expect(setupNotices({ access: { mode: 'hosted', signedIn: true }, consented: true, untranslated: true })).toEqual({
      consentCard: false,
      notice: undefined,
    });
  });

  it('內建翻譯、有 token 但同意被撤回：也是「尚未登入」，重新登入就會再同意', () => {
    expect(setupNotices({ access: { mode: 'hosted', signedIn: true }, consented: false, untranslated: false }).notice).toBe('signedOut');
  });

  it('自備金鑰：沒同意顯示資料使用說明卡；沒有 key 而且有未翻譯的頁才提示設定 key', () => {
    expect(setupNotices({ access: { mode: 'ownKey', hasKey: false }, consented: false, untranslated: false })).toEqual({
      consentCard: true,
      notice: undefined,
    });
    expect(setupNotices({ access: { mode: 'ownKey', hasKey: false }, consented: true, untranslated: true })).toEqual({
      consentCard: false,
      notice: 'noKey',
    });
    expect(setupNotices({ access: { mode: 'ownKey', hasKey: true }, consented: true, untranslated: true }).notice).toBeUndefined();
  });

  it('從舊版更新、仍用自備金鑰：還沒關掉內建翻譯提示時顯示一次；關掉後不再出現', () => {
    const ownKey = { access: { mode: 'ownKey', hasKey: true }, consented: true, untranslated: false } as const;
    expect(setupNotices({ ...ownKey, hostedHint: true }).notice).toBe('hostedHint');
    expect(setupNotices({ ...ownKey, hostedHint: false }).notice).toBeUndefined();
  });

  it('內建翻譯提示只在自備金鑰時出現；「尚未設定 API key」優先', () => {
    expect(setupNotices({ access: { mode: 'hosted', signedIn: true }, consented: true, untranslated: false, hostedHint: true }).notice).toBeUndefined();
    expect(setupNotices({ access: { mode: 'ownKey', hasKey: false }, consented: true, untranslated: true, hostedHint: true }).notice).toBe('noKey');
  });

  it('同意狀態還在讀：什麼都不顯示，不會閃一下', () => {
    expect(setupNotices({ access: { mode: 'hosted', signedIn: false }, consented: undefined, untranslated: true })).toEqual({
      consentCard: false,
      notice: undefined,
    });
    expect(setupNotices({ access: { mode: 'ownKey', hasKey: false }, consented: undefined, untranslated: false }).consentCard).toBe(false);
  });
});

describe('送得出翻譯嗎（底部的「翻譯此頁」）', () => {
  it('目前翻譯模式已登入／有 key，而且同意了才算', () => {
    expect(canTranslate({ mode: 'hosted', signedIn: true }, true)).toBe(true);
    expect(canTranslate({ mode: 'ownKey', hasKey: true }, true)).toBe(true);
    expect(canTranslate({ mode: 'hosted', signedIn: false }, true)).toBe(false);
    expect(canTranslate({ mode: 'ownKey', hasKey: false }, true)).toBe(false);
    expect(canTranslate({ mode: 'ownKey', hasKey: true }, false)).toBe(false);
    expect(canTranslate({ mode: 'hosted', signedIn: true }, undefined)).toBe(false);
  });
});

describe('底部的翻譯按鈕：「翻譯此頁」或「重新翻譯」', () => {
  const action = (transcripts: Transcript[], can = true) => translateAction(transcripts.map((t, i) => page(String(i), `a${i}`, { transcript: t })), can);
  const kuromojiOnly: Transcript = { state: 'done', text: TEXT, translated: false };

  it('有頁還沒翻譯：「翻譯此頁」（只翻那些頁），即使別頁翻好了', () => {
    expect(action([translated(), kuromojiOnly])).toBe('translate');
  });

  it('畫面上的頁都翻好了（含快取）：「重新翻譯」', () => {
    expect(action([translated(), translated({ source: 'cache' })])).toBe('retranslate');
  });

  it('還有頁在辨識或翻譯：都不放，避免連按重複扣頁', () => {
    expect(action([translated(), { state: 'analyzing' }])).toBeUndefined();
    expect(action([translated(), { ...translated(), translating: true }])).toBeUndefined();
    expect(action([kuromojiOnly, { state: 'analyzing' }])).toBe('translate');
  });

  it('送不出翻譯（沒登入、沒 key、沒同意）或畫面上沒有頁：都不放', () => {
    expect(action([translated()], false)).toBeUndefined();
    expect(action([kuromojiOnly], false)).toBeUndefined();
    expect(action([])).toBeUndefined();
  });
});

describe('side panel 顯示哪一個畫面', () => {
  it('沒做完 onboarding：只顯示「完成設定」，即使分頁已啟動、或打開過設定頁', () => {
    expect(sidePanelScreen({ setupComplete: false, page: undefined })).toBe('finishSetup');
    expect(sidePanelScreen({ setupComplete: false, page: 'settings' })).toBe('finishSetup');
  });

  it('設定完成：平常是逐字稿；按 ⚙ 打開設定、從作品卡打開作品頁時整個換成那一頁', () => {
    expect(sidePanelScreen({ setupComplete: true, page: undefined })).toBe('transcript');
    expect(sidePanelScreen({ setupComplete: true, page: 'settings' })).toBe('settings');
    expect(sidePanelScreen({ setupComplete: true, page: 'series' })).toBe('series');
  });

  it('換一部作品是作品頁再進去的一頁（#191）：「←」回到作品頁，從作品卡的「換一部」直接打開也一樣', () => {
    expect(sidePanelScreen({ setupComplete: true, page: 'seriesPick' })).toBe('seriesPick');
    expect(parentPage('seriesPick')).toBe('series');
  });

  it('設定、作品頁的「←」回到逐字稿', () => {
    expect(parentPage('settings')).toBeUndefined();
    expect(parentPage('series')).toBeUndefined();
  });
});

const signedIn = { mode: 'hosted', signedIn: true } as const;
const free = (remaining: number) => ({ plan: 'free', remaining }) as const;

describe('作品頁與作品卡的操作（#191）', () => {
  const option = (id: string, extra: Partial<SeriesOption> = {}): SeriesOption => ({
    id, name: id, label: id, title: id, provisional: false, createdAt: 0, ...extra,
  });
  const confirmed = option('星落小鎮的郵差', { originalTitles: ['星降る町の郵便屋'] });
  const other = option('鐵之庭');
  const guessed = option('海辺のアトリエ', { provisional: true, originalTitles: ['海辺のアトリエ'] });
  const unnamed = option('未命名・reader.example・11/4', { provisional: true });

  it('確認過的作品：沒有問句列（作品頁改用「不是這部作品？」），名稱旁是「改名」，不能當合併的來源', () => {
    expect(seriesActions(confirmed, [confirmed, other, guessed])).toEqual({
      ask: undefined, rename: '改名', mergeTargets: [],
    });
  });

  it('自動判斷、猜到原名：問「這是正確的作品嗎？」（是／換一部），可以合併進確認過的作品', () => {
    expect(seriesActions(guessed, [confirmed, guessed, unnamed, other])).toEqual({
      ask: 'confirm', rename: '改名', mergeTargets: [confirmed, other],
    });
  });

  it('猜不出來：問「看不出是哪部作品」（取名字／選一部），改名叫「取名字」', () => {
    expect(seriesActions(unnamed, [unnamed])).toEqual({
      ask: 'name', rename: '取名字', mergeTargets: [],
    });
  });
});

describe('內建翻譯的額度（底部那一行）', () => {
  it('剩 37 頁：「免費額度剩 37 頁」，旁邊有「訂閱」連結，不用警告色', () => {
    expect(quotaView(signedIn, free(37)).line).toEqual({ text: '免費額度剩 37 頁', warn: false, subscribeLink: true });
  });

  it('Free Pages 剩 25 頁以下改用警告色（跟圖示的橘點同一個門檻，#237）', () => {
    expect(quotaView(signedIn, free(26)).line).toMatchObject({ warn: false });
    expect(quotaView(signedIn, free(25)).line).toMatchObject({ text: '免費額度剩 25 頁', warn: true });
    expect(quotaView(signedIn, free(1)).line).toMatchObject({ warn: true });
  });

  it('自備金鑰、沒登入、額度還在讀時不顯示', () => {
    expect(quotaView({ mode: 'ownKey', hasKey: true }, undefined).line).toBeUndefined();
    expect(quotaView({ mode: 'hosted', signedIn: false }, undefined).line).toBeUndefined();
    expect(quotaView(signedIn, undefined).line).toBeUndefined();
  });
});

describe('內建翻譯的免費額度用完', () => {
  it('底部那一行改成「免費額度已用完」（警告色、沒有「訂閱」小字），逐字稿上方顯示用完的 Callout（有訂閱），底部按鈕換成「訂閱」', () => {
    expect(quotaView(signedIn, free(0))).toEqual({
      line: { text: '免費額度已用完', warn: true, subscribeLink: false },
      exhausted: {
        title: '免費額度已用完',
        body: '已翻過的頁面照常顯示譯文；新的頁面先顯示原文與讀音。訂閱後每月可翻 3,000 頁。',
        subscribe: true,
      },
      footerButton: 'subscribe',
    });
  });

  it('還有額度時沒有 Callout，底部照常是翻譯按鈕', () => {
    expect(quotaView(signedIn, free(3))).toMatchObject({ exhausted: undefined, footerButton: 'translate' });
  });

  it('自備金鑰時不看額度', () => {
    expect(quotaView({ mode: 'ownKey', hasKey: true }, free(0))).toEqual({ line: undefined, exhausted: undefined, footerButton: 'translate' });
  });
});

/** 本機時區的 2026 年 11 月 15 日上午（重置日期依讀者的時區顯示）。 */
const nov15 = new Date(2026, 10, 15, 11, 0).getTime();
const oct15NextYear = new Date(2027, 9, 15, 11, 0).getTime();

const subscribed = (fields: Partial<Extract<Quota, { plan: 'subscribed' }>> = {}): Quota => ({
  plan: 'subscribed',
  remaining: 612,
  limit: 3000,
  resetsAt: nov15,
  status: 'active',
  cancelScheduled: false,
  periodEndsAt: oct15NextYear,
  billingPeriod: 'yearly',
  renewalPriceUsd: 48,
  ...fields,
});

describe('訂閱者的本月額度（#94 畫面定案）', () => {
  it('底部那一行是「本月剩 612 頁・11 月 15 日重置」，沒有「訂閱」連結，不顯示免費額度', () => {
    expect(quotaView(signedIn, subscribed())).toEqual({
      line: { text: '本月剩 612 頁・11 月 15 日重置', warn: false, subscribeLink: false },
      exhausted: undefined,
      footerButton: 'translate',
    });
  });

  it('本月額度剩 300 頁以下改用警告色（跟圖示的橘點同一個門檻）', () => {
    expect(quotaView(signedIn, subscribed({ remaining: 301 })).line).toMatchObject({ warn: false });
    expect(quotaView(signedIn, subscribed({ remaining: 300 })).line).toMatchObject({ text: '本月剩 300 頁・11 月 15 日重置', warn: true });
  });

  it('扣款失敗、排定取消：side panel 照常，不顯示任何提示', () => {
    expect(quotaView(signedIn, subscribed({ status: 'pastDue' }))).toEqual(quotaView(signedIn, subscribed()));
    expect(quotaView(signedIn, subscribed({ cancelScheduled: true }))).toEqual(quotaView(signedIn, subscribed()));
  });

  it('本月額度用完：Callout 只有「使用自備金鑰」（沒有訂閱），底部那一行同樣文字，底部不放按鈕', () => {
    expect(quotaView(signedIn, subscribed({ remaining: 0 }))).toEqual({
      line: { text: '本月額度已用完，11 月 15 日重置', warn: true, subscribeLink: false },
      exhausted: {
        title: '本月額度已用完，11 月 15 日重置',
        body: '已翻過的頁面照常顯示譯文；新的頁面先顯示原文與讀音，重置後就能繼續翻。',
        subscribe: false,
      },
      footerButton: 'none',
    });
  });
});

describe('設定頁的方案（#94 畫面定案）', () => {
  it('免費：「免費」Badge、免費額度剩 N / 100 頁、可以訂閱', () => {
    expect(accountPlanView(free(37))).toEqual({ badge: { text: '免費', tone: 'neutral' }, lines: ['免費額度剩 37 / 100 頁'], subscribed: false });
  });

  it('訂閱中：ok「訂閱中」、本月剩餘與重置日、下次續訂日', () => {
    expect(accountPlanView(subscribed())).toEqual({
      badge: { text: '訂閱中', tone: 'ok' },
      lines: ['本月剩 612 / 3,000 頁，11 月 15 日重置', '下次續訂：2027 年 10 月 15 日'],
      subscribed: true,
    });
  });

  it('排定取消：warn「訂閱中・不會續訂」、訂閱結束日', () => {
    expect(accountPlanView(subscribed({ cancelScheduled: true }))).toMatchObject({
      badge: { text: '訂閱中・不會續訂', tone: 'warn' },
      lines: ['本月剩 612 / 3,000 頁，11 月 15 日重置', '訂閱在 2027 年 10 月 15 日結束'],
    });
  });

  it('past_due：warn「扣款失敗，重試中」、請到管理訂閱更新付款方式', () => {
    expect(accountPlanView(subscribed({ status: 'pastDue' }))).toMatchObject({
      badge: { text: '扣款失敗，重試中', tone: 'warn' },
      lines: ['本月剩 612 / 3,000 頁，11 月 15 日重置', 'Paddle 會再嘗試扣款，這段期間照常可以使用；請到「管理訂閱」更新付款方式'],
    });
  });
});

describe('帳號與訂閱頁（#213）', () => {
  const hosted = { mode: 'hosted', signedIn: true, justPaid: undefined, payment: undefined, justSignedIn: false, hasOrigin: true, now: Date.now() } as const;
  /** 帳號頁的「訂閱」區塊（設計稿 A 版：年繳在左、季繳在右）。 */
  const subscribeSection = {
    headline: '每月 3,000 頁・14 天內可全額退款',
    offers: [
      { billingPeriod: 'yearly', name: '年繳', price: 'US$48', detail: '平均每月 US$4・省 20%', recommended: true, subscribe: '訂閱年繳' },
      { billingPeriod: 'quarterly', name: '季繳', price: 'US$15', detail: '每 3 個月扣款', recommended: false, subscribe: '訂閱季繳' },
    ],
    note: '從訂閱那天起每月同一天重置，隨時可以取消。付款頁會在新分頁打開（由 Paddle 處理付款）。',
  };

  it('免費額度用完：warn 說明不提訂閱、進度條是空的、有訂閱段', () => {
    expect(accountPageView({ ...hosted, quota: free(0) })).toEqual({
      notice: { tone: 'warn', title: '免費額度已用完', body: '已翻過的頁面照常顯示譯文；新的頁面先顯示原文與讀音。', backToManga: false },
      plan: {
        name: '免費',
        badge: undefined,
        note: '新帳號一次 100 頁，不會過期',
        manage: false,
        rows: [],
        quotaLabel: '免費額度',
        left: '已用完',
        reset: undefined,
        fraction: 0,
        warn: true,
      },
      payment: undefined,
      subscribe: subscribeSection,
      ownKeyNote: false,
      signedOut: undefined,
    });
  });

  it('免費還有剩：沒有說明，剩 N / 100 頁，進度條畫剩下的比例；剩 25 頁以下變警告色', () => {
    expect(accountPageView({ ...hosted, quota: free(30) })).toMatchObject({
      notice: undefined,
      plan: { left: '剩 30 / 100 頁', fraction: 0.3, warn: false },
      subscribe: subscribeSection,
    });
    expect(accountPageView({ ...hosted, quota: free(25) }).plan).toMatchObject({ left: '剩 25 / 100 頁', warn: true });
  });

  it('年繳訂閱中（設計稿 B 版）：「訂閱」＋ok「訂閱中」、管理訂閱；扣款週期、下次續訂的日期與金額、本月額度與重置日；沒有訂閱段', () => {
    expect(accountPageView({ ...hosted, quota: subscribed() })).toEqual({
      notice: undefined,
      plan: {
        name: '訂閱',
        badge: { text: '訂閱中', tone: 'ok' },
        note: undefined,
        manage: true,
        rows: [
          { label: '扣款週期', value: '年繳', warn: false },
          { label: '下次續訂', value: '2027 年 10 月 15 日・US$48', warn: false },
        ],
        quotaLabel: '本月額度',
        left: '剩 612 / 3,000 頁',
        reset: '11 月 15 日重置',
        fraction: 0.204,
        warn: false,
      },
      payment: undefined,
      subscribe: undefined,
      ownKeyNote: false,
      signedOut: undefined,
    });
  });

  it('季繳訂閱中：扣款週期「季繳」，下次續訂 US$15', () => {
    const jan15 = new Date(2027, 0, 15, 11, 0).getTime();
    expect(accountPageView({ ...hosted, quota: subscribed({ billingPeriod: 'quarterly', renewalPriceUsd: 15, periodEndsAt: jan15 }) }).plan?.rows).toEqual([
      { label: '扣款週期', value: '季繳', warn: false },
      { label: '下次續訂', value: '2027 年 1 月 15 日・US$15', warn: false },
    ]);
  });

  it('舊訂閱者（原本年繳 US$20）：Worker 給的下次續訂金額是新的年繳價，卡片寫 US$48', () => {
    const mar1 = new Date(2027, 2, 1, 11, 0).getTime();
    expect(accountPageView({ ...hosted, quota: subscribed({ periodEndsAt: mar1 }) }).plan?.rows).toContainEqual({
      label: '下次續訂',
      value: '2027 年 3 月 1 日・US$48',
      warn: false,
    });
  });

  it('排定取消：warn「訂閱中・不會續訂」，「訂閱結束」只寫日期（不會再扣款）', () => {
    expect(accountPageView({ ...hosted, quota: subscribed({ cancelScheduled: true }) }).plan).toMatchObject({
      badge: { text: '訂閱中・不會續訂', tone: 'warn' },
      manage: true,
      rows: [
        { label: '扣款週期', value: '年繳', warn: false },
        { label: '訂閱結束', value: '2027 年 10 月 15 日', warn: false },
      ],
    });
  });

  it('扣款失敗重試中：warn「扣款失敗，重試中」，「扣款」那一列用警告色請讀者更新付款方式，不寫下次續訂', () => {
    expect(accountPageView({ ...hosted, quota: subscribed({ status: 'pastDue', billingPeriod: 'quarterly', renewalPriceUsd: 15 }) }).plan).toMatchObject({
      badge: { text: '扣款失敗，重試中', tone: 'warn' },
      manage: true,
      rows: [
        { label: '扣款週期', value: '季繳', warn: false },
        { label: '扣款', value: 'Paddle 會再嘗試扣款，這段期間照常可以使用；請到「管理訂閱」更新付款方式', warn: true },
      ],
    });
  });

  it('訂閱者本月剩 300 頁以下：進度條變警告色', () => {
    expect(accountPageView({ ...hosted, quota: subscribed({ remaining: 301 }) }).plan).toMatchObject({ left: '剩 301 / 3,000 頁', warn: false });
    expect(accountPageView({ ...hosted, quota: subscribed({ remaining: 300 }) }).plan).toMatchObject({ left: '剩 300 / 3,000 頁', warn: true });
  });

  it('訂閱者本月用完：warn 說明帶重置日；從漫畫來的才有「回到漫畫」', () => {
    const view = accountPageView({ ...hosted, quota: subscribed({ remaining: 0 }) });
    expect(view.notice).toEqual({
      tone: 'warn',
      title: '本月額度已用完，11 月 15 日重置',
      body: '已翻過的頁面照常顯示譯文；新的頁面先顯示原文與讀音，重置後就會繼續翻。',
      backToManga: true,
    });
    expect(view.plan).toMatchObject({ badge: { text: '訂閱中', tone: 'ok' }, left: '本月已用完', reset: '11 月 15 日重置', fraction: 0, warn: true });
    expect(accountPageView({ ...hosted, hasOrigin: false, quota: subscribed({ remaining: 0 }) }).notice?.backToManga).toBe(false);
  });

  it('在這頁付完年繳：info「✓ 訂閱完成」帶扣款週期；從漫畫來的才有「回到漫畫」與接著翻的說明', () => {
    expect(accountPageView({ ...hosted, justPaid: 'yearly', quota: subscribed({ remaining: 3000 }) }).notice).toEqual({
      tone: 'info',
      title: '✓ 訂閱完成',
      body: '年繳，每月可翻 3,000 頁。回到漫畫後會自動接著翻還沒翻的頁。',
      backToManga: true,
    });
    expect(accountPageView({ ...hosted, justPaid: 'yearly', hasOrigin: false, quota: subscribed({ remaining: 3000 }) }).notice).toEqual({
      tone: 'info',
      title: '✓ 訂閱完成',
      body: '年繳，每月可翻 3,000 頁。',
      backToManga: false,
    });
  });

  it('在這頁付完季繳：「季繳，每月可翻 N 頁」', () => {
    expect(accountPageView({ ...hosted, justPaid: 'quarterly', quota: subscribed({ remaining: 3000 }) }).notice?.body).toBe(
      '季繳，每月可翻 3,000 頁。回到漫畫後會自動接著翻還沒翻的頁。',
    );
  });

  it('付款中（付款分頁開著）：「你選的是」那一行、回到付款頁；收起訂閱區塊，也不顯示免費額度用完', () => {
    const view = accountPageView({ ...hosted, quota: free(0), payment: { billingPeriod: 'yearly', checkoutClosed: false } });
    expect(view.payment).toEqual({
      title: '在付款分頁完成付款',
      chosen: subscribeSection.offers[0],
      body: '付款頁已經在另一個分頁打開（由 Paddle 處理付款）。付款完成後，會自動帶你回到這裡。',
      button: '回到付款頁',
      billingPeriod: 'yearly',
    });
    expect(view.subscribe).toBeUndefined();
    expect(view.notice).toBeUndefined();
  });

  it('付款中選的是季繳：「你選的是」季繳', () => {
    const view = accountPageView({ ...hosted, quota: free(30), payment: { billingPeriod: 'quarterly', checkoutClosed: false } });
    expect(view.payment?.chosen).toEqual(subscribeSection.offers[1]);
  });

  it('付款頁已經關閉：可以重新打開那個週期的付款頁，訂閱區塊回來讓讀者改選另一種', () => {
    const view = accountPageView({ ...hosted, quota: free(0), payment: { billingPeriod: 'quarterly', checkoutClosed: true } });
    expect(view.payment).toEqual({
      title: '付款頁已經關閉',
      chosen: undefined,
      body: '還沒付款的話，可以重新打開付款頁，或在下面改選另一種扣款週期。如果你已經付款，確認後這裡會自動更新。',
      button: '重新打開付款頁（季繳）',
      billingPeriod: 'quarterly',
    });
    expect(view.subscribe).toEqual(subscribeSection);
    expect(view.notice).toBeUndefined();
  });

  it('付款中但 Worker 已經是訂閱中（SW 還沒清掉付款狀態）：不再顯示付款中', () => {
    const view = accountPageView({ ...hosted, quota: subscribed(), payment: { billingPeriod: 'yearly', checkoutClosed: false } });
    expect(view.payment).toBeUndefined();
  });

  it('沒登入：說明怎麼登入；正在用自備金鑰的話說不需要登入', () => {
    expect(accountPageView({ ...hosted, signedIn: false, quota: undefined })).toEqual({
      notice: undefined,
      plan: undefined,
      payment: undefined,
      subscribe: undefined,
      ownKeyNote: false,
      signedOut: '尚未登入。登入後就能用內建翻譯，新帳號有 100 頁免費額度。',
    });
    expect(accountPageView({ ...hosted, mode: 'ownKey', signedIn: false, quota: undefined }).signedOut).toBe(
      '目前用自備金鑰翻譯，不需要登入。想改用內建翻譯的話可以登入，新帳號有 100 頁免費額度。',
    );
  });

  it('自備金鑰模式但帳號還登入著：說明不會用到這個帳號的頁數，額度用完也不跳說明', () => {
    const view = accountPageView({ ...hosted, mode: 'ownKey', quota: free(0) });
    expect(view).toMatchObject({ ownKeyNote: true, notice: undefined, signedOut: undefined });
  });

  it('從漫畫來、在這頁登入了還能翻：info「✓ 已登入」與「回到漫畫」', () => {
    expect(accountPageView({ ...hosted, justSignedIn: true, quota: free(30) }).notice).toEqual({
      tone: 'info',
      title: '✓ 已登入',
      body: '回到漫畫後會接著翻譯。',
      backToManga: true,
    });
    expect(accountPageView({ ...hosted, justSignedIn: true, hasOrigin: false, quota: free(30) }).notice).toBeUndefined();
  });
});


describe('帳號頁的退款區塊（#260，設計稿 B 版）', () => {
  const hosted = { mode: 'hosted', signedIn: true, justPaid: undefined, payment: undefined, justSignedIn: false, hasOrigin: false } as const;
  /** 本機時區 11 月 3 日扣款，Refund Window 到 11 月 17 日；現在是 11 月 10 日（還剩 7 天）。 */
  const billedAt = new Date(2026, 10, 3, 11, 0).getTime();
  const windowEndsAt = new Date(2026, 10, 17, 11, 0).getTime();
  const now = new Date(2026, 10, 10, 11, 0).getTime();
  const refund = (fields: Partial<RefundInfo> = {}): RefundInfo => ({ billedAt, amountUsd: 48, windowEndsAt, inWindow: true, status: 'none', eligible: true, ...fields });
  const plan = (quota: Quota, r: RefundInfo | undefined) => accountPageView({ ...hosted, now, quota, refund: r }).plan;

  it('在退款期內：標題、扣款日與金額、還剩幾天，以及「申請退款」', () => {
    expect(plan(subscribed(), refund())?.refund).toEqual({
      kind: 'offer',
      title: '扣款後 14 天內可以申請全額退款',
      detail: '11 月 3 日已扣款 US$48・還剩 7 天（到 11 月 17 日）',
    });
  });

  it('最後一天不到 24 小時：還剩 1 天', () => {
    const lastDay = windowEndsAt - 60 * 60_000;
    expect(accountPageView({ ...hosted, now: lastDay, quota: subscribed(), refund: refund() }).plan?.refund).toMatchObject({ detail: expect.stringContaining('還剩 1 天') });
  });

  it('部分折扣：寫實付金額', () => {
    expect(plan(subscribed(), refund({ amountUsd: 1 }))?.refund).toMatchObject({ detail: '11 月 3 日已扣款 US$1・還剩 7 天（到 11 月 17 日）' });
  });

  it('已排定取消、還在退款期內：照樣有退款區塊', () => {
    expect(plan(subscribed({ cancelScheduled: true }), refund())?.refund).toMatchObject({ kind: 'offer' });
  });

  const hidden: [string, Quota, RefundInfo | undefined][] = [
    ['沒有扣款紀錄（舊版 Worker、或還沒收到扣款）', subscribed(), undefined],
    ['實付 US$0', subscribed(), refund({ amountUsd: 0, eligible: false })],
    ['過了退款期', subscribed(), refund({ inWindow: false, eligible: false })],
    ['扣款失敗重試中', subscribed({ status: 'pastDue' }), refund({ eligible: false })],
    ['免費方案', { plan: 'free', remaining: 62 }, refund()],
  ];
  for (const [name, quota, r] of hidden) {
    it(`${name}：不顯示退款區塊`, () => {
      expect(plan(quota, r)?.refund).toBeUndefined();
    });
  }

  it('退款處理中：同一個位置換成「退款處理中」，「管理訂閱」照樣保留', () => {
    expect(plan(subscribed(), refund({ status: 'pending', eligible: false }))).toMatchObject({
      manage: true,
      refund: { kind: 'pending', title: '退款處理中', body: '已向 Paddle 申請退回 11 月 3 日扣款的 US$48。核准前照常可以翻譯；核准後訂閱就會結束。' },
    });
  });

  it('退款處理中、已過退款期：照樣顯示處理中', () => {
    expect(plan(subscribed(), refund({ status: 'pending', inWindow: false, eligible: false }))?.refund).toMatchObject({ kind: 'pending' });
  });
});

describe('申請退款的確認對話框（#260）', () => {
  const billedAt = new Date(2026, 10, 3, 11, 0).getTime();
  const refund: RefundInfo = { billedAt, amountUsd: 48, windowEndsAt: billedAt + 14 * 86_400_000, inWindow: true, status: 'none', eligible: true };

  it('退多少、退回哪裡、核准後訂閱結束、Free Pages 恢復、核准前照常翻譯', () => {
    expect(refundDialogView(subscribed({ freePages: 62 }) as SubscribedQuota, refund)).toEqual({
      title: '退款 US$48，並結束訂閱？',
      points: [
        '11 月 3 日扣款的 US$48 會全額退回原本的付款方式，由 Paddle 處理。',
        'Paddle 核准退款後，訂閱就會結束，不再有每月 3,000 頁。',
        '訂閱前剩下的 62 頁免費額度會恢復可用。',
        '核准之前照常可以翻譯。',
      ],
      cancel: '先不要',
      confirm: '確定退款',
    });
  });

  it('訂閱前的 Free Pages 已經用完：說訂閱結束後沒有免費額度', () => {
    expect(refundDialogView(subscribed({ freePages: 0 }) as SubscribedQuota, refund).points[2]).toBe('訂閱前的免費額度已經用完，訂閱結束後就不能再翻新的頁。');
  });
});
