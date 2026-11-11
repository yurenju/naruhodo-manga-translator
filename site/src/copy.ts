import type { Locale } from './locale.ts';
import type { LegalDoc } from './links.ts';
import { type BillingPeriod, FREE_PAGES, MONTHLY_PAGES, pageCount, PERIOD_MONTHS, PRICE_USD, REFUND_WINDOW_DAYS } from '../../src/shared/hosted-api.ts';
import { FREE_PAGES_EPISODES, monthlyPriceUsd, SUBSCRIPTION_OFFERS, subscriptionHeadline, usd, yearlySavingPercent } from '../../src/ui/pricing.ts';

/**
 * 網站文案（#89 A 版定稿，價格區塊是 spec #254 的新方案）。`[TBD]` 會畫成明顯的 TBD 標記（Copy.astro），
 * 標在還沒定案的文字旁；Paddle 審核網站時看到 TBD 會當成還沒完成，所以上線的文案不放。
 */
export interface SiteCopy {
  /** 頁面 <title> 開頭的產品全名（跟外掛的 manifest name 一致）；頁首與內文仍寫 Naruhodo */
  brand: string;
  nav: { pricing: string; faq: string; install: string; languageLabel: string };
  hero: { title: string; lead: string; install: string; pricing: string };
  /** 首頁互動展示（#109）外框上的文字；展示裡面的外掛介面只有繁體中文 */
  demo: { caption: string; hint: string };
  /** 步驟內文的 `{shortcut}` 換成外掛快捷鍵的按鍵（Mac 是 ⌥⇧M，其他平台 Alt+Shift+M） */
  how: { title: string; steps: readonly { title: string; body: string }[] };
  /**
   * 試翻頁（#169）。步驟內文的 `{puzzle}` 換成 Chrome 工具列的拼圖圖示、`{shortcut}` 換成外掛快捷鍵的按鍵；
   * 漫畫本身（Practice Spread）是日文，不跟著語言換。
   */
  try: { title: string; lead: string; free: string; steps: readonly { title: string; body: string }[]; notInstalled: string; install: string; spreadAlt: string; puzzleLabel: string };
  /**
   * 價格區（spec #254 設計稿「購買流程」的網站定價區塊）：免費、年繳（推薦）、季繳三張卡片並排，卡片裡都不放按鈕；
   * 下面一張白卡是三步驟＋唯一的按鈕。付款只能在外掛裡（要先有帳號），所以按鈕一律是安裝，
   * 已經安裝的人看按鈕旁邊那一行（`installed`）去外掛裡選方案。
   */
  pricing: {
    title: string;
    lead: string;
    /** 第一個重點是「{grant.lead} <strong>{grant.pages}</strong>{grant.note}」，接著是 `items` */
    free: { title: string; tag: string; price: string; grant: { lead: string; pages: string; note: string }; items: readonly string[] };
    /** 年繳在前（推薦、加粗框）。價格那一行是「<strong>{name}</strong>・{detail}」 */
    plans: readonly PlanCard[];
    /** 卡片下面的小字：兩種 Billing Period 內容一樣 */
    note: string;
    start: { steps: readonly { title: string; body: string }[]; cta: string; installed: string };
    ownKey: string;
  };
  /** `a` 裡的 `{link}` 換成 `link` 那份法律文件的連結；`discussions` 換成討論區連結，文字是 `discussions` */
  faq: { title: string; discussions: string; items: readonly { q: string; a: string; link?: LegalDoc | 'discussions' }[] };
  /** `discussions` 是頁尾的討論區連結 */
  legal: Record<LegalDoc, string> & { englishOnly: string; source: string; discussions: string };
  checkout: {
    title: string;
    loading: string;
    hint: string;
    closed: string;
    reopen: string;
    completed: string;
    /** 付款完成後 SW 一直沒把分頁關掉（webhook 很慢、外掛的分頁已經關了）：補一句可以自己關 */
    slow: string;
    /** Paddle 視窗在付款前被關掉：關掉分頁就會回到外掛 */
    cancel: string;
    failed: string;
    retry: string;
    missing: string;
    /**
     * 方案摘要。付款頁不知道讀者選了哪一種 Billing Period（外掛建立 transaction 時選的），
     * 金額看 Paddle 的付款畫面，這裡只寫兩種共通的內容。
     */
    plan: string;
    pagesPerMonth: string;
    pagesValue: string;
    refundLabel: string;
    refund: string;
    agree: string;
  };
}

export interface PlanCard {
  title: string;
  tag?: string;
  featured: boolean;
  name: string;
  detail: string;
  items: readonly string[];
}

// 價格與頁數跟外掛共用同一份常數（src/shared/hosted-api.ts），繁中的價格文案直接用外掛那幾句（src/ui/pricing.ts）
const ZH_ITEMS: Record<BillingPeriod, readonly string[]> = {
  yearly: [subscriptionHeadline(), '一年扣款一次，自動續訂', '隨時可以取消'],
  quarterly: [subscriptionHeadline(), '先付少一點試試，自動續訂', '隨時可以取消'],
};
const ZH_PLANS: readonly PlanCard[] = SUBSCRIPTION_OFFERS.map((offer) => ({
  title: '訂閱',
  ...(offer.recommended && { tag: '推薦' }),
  featured: offer.recommended,
  name: `${offer.name} ${offer.price}`,
  detail: offer.detail,
  items: ZH_ITEMS[offer.billingPeriod],
}));

const enUsd = (amount: number) => usd(amount).replace('US$', '$');
const EN_HEADLINE = `${pageCount(MONTHLY_PAGES)} pages a month · full refund within ${REFUND_WINDOW_DAYS} days`;
// 英文版跟繁中一樣由 SUBSCRIPTION_OFFERS 決定順序與推薦，只換掉文字
const EN_NAME: Record<BillingPeriod, string> = { quarterly: 'Quarterly', yearly: 'Yearly' };
const EN_DETAIL: Record<BillingPeriod, string> = {
  quarterly: `Billed every ${PERIOD_MONTHS.quarterly} months`,
  yearly: `About ${enUsd(monthlyPriceUsd('yearly'))} a month · save ${yearlySavingPercent()}%`,
};
const EN_ITEMS: Record<BillingPeriod, readonly string[]> = {
  yearly: [EN_HEADLINE, 'Billed once a year, renews automatically', 'Cancel anytime'],
  quarterly: [EN_HEADLINE, 'Pay less up front to try it, renews automatically', 'Cancel anytime'],
};
const EN_PLANS: readonly PlanCard[] = SUBSCRIPTION_OFFERS.map(({ billingPeriod, recommended }) => ({
  title: 'Subscription',
  ...(recommended && { tag: 'Recommended' }),
  featured: recommended,
  name: `${EN_NAME[billingPeriod]} ${enUsd(PRICE_USD[billingPeriod])}`,
  detail: EN_DETAIL[billingPeriod],
  items: EN_ITEMS[billingPeriod],
}));

export const copy: Record<Locale, SiteCopy> = {
  'zh-tw': {
    brand: 'Naruhodo 日文漫畫翻譯',
    nav: { pricing: '價格', faq: '常見問題', install: '安裝外掛', languageLabel: '語言' },
    hero: {
      title: '新番日漫，不再苦等翻譯！',
      lead: 'Naruhodo 是一個 Chrome 外掛。點一下圖示，對話框裡的日文就會變成繁體中文，還附上讀音，邊看邊學日文。',
      install: '加到 Chrome',
      pricing: '看價格',
    },
    demo: {
      caption: '實際操作看看：點右上角的 Naruhodo 圖示，切到「學習」後把滑鼠移到對話框上；再點一次圖示就關掉。',
      hint: '點這裡開始翻譯',
    },
    how: {
      title: '怎麼用',
      steps: [
        { title: '安裝並登入', body: '輸入 email，收到驗證碼貼回來就登入，不用設定密碼。' },
        { title: '打開你在看的漫畫', body: '在漫畫頁上點外掛圖示，或按 {shortcut}。' },
        { title: '對照著看', body: '譯文疊在對話框上，原文與讀音都留著；已經翻過的頁面再看不會再算一次。' },
      ],
    },
    try: {
      title: '試翻一頁看看',
      lead: '下面是一張原創的日文漫畫跨頁。照著三個步驟，用 Naruhodo 把它翻成中文。',
      free: '這一頁不會用到額度。',
      steps: [
        { title: '釘選圖示', body: '點網址列右邊的拼圖 {puzzle}，把 Naruhodo 釘選到工具列。' },
        { title: '啟動翻譯', body: '點工具列上的 Naruhodo 圖示，或按 {shortcut}。右邊會打開 side panel。' },
        { title: '看讀音', body: '翻好之後，把滑鼠移到對話框上，看原文、讀音和譯文。' },
      ],
      notInstalled: '還沒安裝？',
      install: '加到 Chrome',
      spreadAlt: '原創日文漫畫跨頁',
      puzzleLabel: '拼圖圖示',
    },
    pricing: {
      title: '價格',
      lead: '先用免費額度試試看。想繼續的話，訂閱只有一個方案，選季繳或年繳。',
      free: {
        title: '免費額度',
        tag: '不需信用卡',
        price: 'US$0',
        grant: { lead: '註冊就送', pages: `${pageCount(FREE_PAGES)} 頁`, note: `，${FREE_PAGES_EPISODES}` },
        items: ['不會過期', '用 email 註冊就能翻譯'],
      },
      plans: ZH_PLANS,
      note: '年繳和季繳的內容完全一樣，只差扣款週期。每月在你訂閱的那天重置；以美元計價，標價就是刷卡金額。',
      start: {
        steps: [
          { title: '加到 Chrome', body: '從 Chrome 線上應用程式商店安裝' },
          { title: '用 email 註冊', body: `馬上拿到 ${pageCount(FREE_PAGES)} 頁免費額度` },
          { title: '想繼續再訂閱', body: '在外掛裡選季繳或年繳，然後付款' },
        ],
        cta: '加到 Chrome，免費開始',
        installed: '已經安裝了？點工具列上的 Naruhodo 圖示，右鍵選「帳號與訂閱」。',
      },
      ownKey: '已經有 Anthropic API key？也可以改用自備金鑰，不需要帳號、沒有頁數限制。',
    },
    faq: {
      title: '常見問題',
      discussions: '討論區',
      items: [
        {
          q: 'Naruhodo 怎麼處理漫畫頁面？',
          a: '找出對話框與辨識文字都在你的電腦上進行，辨識出來的日文會送去翻譯。詳見{link}。',
          link: 'privacy',
        },
        {
          q: 'Naruhodo 會保存或分享我看的漫畫嗎？',
          a: '不會。漫畫圖片不會離開你的電腦，送去翻譯的只有辨識出來的日文文字。翻好的內容只存在你自己的瀏覽器裡，方便你下次翻回這一頁時不用重新翻譯。',
        },
        { q: '一頁怎麼算？', a: '成功翻譯一頁算一頁，要求重新翻譯也算；跨頁算兩頁。再看已經翻過的頁面、或翻譯失敗，都不算。' },
        { q: '可以退款嗎？', a: '詳見{link}。', link: 'refund' },
        {
          q: '可以在哪些網站上用？',
          a: 'Naruhodo 會找出頁面上大張的漫畫圖片，辨識裡面的文字再翻譯，所以不限定特定網站。每個網站的版面不太一樣，如果遇到翻不出來的頁面，歡迎到{link}回報。',
          link: 'discussions',
        },
      ],
    },
    legal: {
      terms: '服務條款',
      refund: '退款政策',
      privacy: '隱私權政策',
      englishOnly: '法律文件僅提供英文版本，以英文內容為準。',
      source: '原始碼',
      discussions: '討論區',
    },
    checkout: {
      title: '付款',
      loading: '正在開啟付款畫面…',
      hint: '付款由 Paddle 處理，Naruhodo 不會看到你的卡號。',
      closed: '付款畫面已經關閉。',
      reopen: '重新開啟付款畫面',
      completed: '付款完成，正在帶你回到外掛…',
      slow: '如果沒有自動回去，可以直接關掉這個分頁。',
      cancel: '不想付款的話，直接關掉這個分頁就會回到外掛。',
      failed: '付款畫面沒有成功載入。請檢查網路連線後再試一次。',
      retry: '重新載入',
      missing: '這個付款連結不完整。請回到外掛，重新打開付款頁。',
      plan: 'Naruhodo 訂閱',
      pagesPerMonth: '每月頁數',
      pagesValue: `${pageCount(MONTHLY_PAGES)} 頁`,
      refundLabel: '退款',
      refund: `扣款後 ${REFUND_WINDOW_DAYS} 天內可全額退款`,
      agree: '付款即表示同意',
    },
  },
  en: {
    brand: 'Naruhodo: Japanese Manga Translator',
    nav: { pricing: 'Pricing', faq: 'FAQ', install: 'Install', languageLabel: 'Language' },
    hero: {
      title: 'Read Japanese manga with Chinese right where the words are',
      lead: 'Naruhodo is a Chrome extension. Click its icon and it finds the manga page on your screen, reads the Japanese in each speech balloon, and places a Traditional Chinese translation right back where the text was, with furigana so you learn Japanese as you read.',
      install: 'Add to Chrome',
      pricing: 'See pricing',
    },
    demo: {
      caption: 'Try it: click the Naruhodo icon at the top right, then switch to 學習 (Study) and hover a balloon. Click the icon again to turn it off.',
      hint: 'Click to translate',
    },
    how: {
      title: 'How it works',
      steps: [
        { title: 'Install and sign in', body: 'Enter your email and paste back the code we send. No password needed.' },
        { title: "Open the manga you're reading", body: 'On the page, click the extension icon or press {shortcut}.' },
        { title: 'Read side by side', body: 'Translations sit on the balloons, with the original text and readings kept. Revisiting a translated page never counts again.' },
      ],
    },
    try: {
      title: 'Try translating a page',
      lead: 'Below is an original Japanese manga spread. Follow the three steps to translate it with Naruhodo.',
      free: 'This page does not use your quota.',
      steps: [
        { title: 'Pin the icon', body: 'Click the puzzle piece {puzzle} to the right of the address bar and pin Naruhodo to the toolbar.' },
        { title: 'Start translating', body: 'Click the Naruhodo icon on the toolbar, or press {shortcut}. The side panel opens on the right.' },
        { title: 'See the readings', body: 'Once translated, hover a speech balloon to see the Japanese, its reading and the translation.' },
      ],
      notInstalled: 'Not installed yet?',
      install: 'Add to Chrome',
      spreadAlt: 'Original Japanese manga spread',
      puzzleLabel: 'puzzle icon',
    },
    pricing: {
      title: 'Pricing',
      lead: 'Start with the free pages. If you want more, there is one subscription: pay quarterly or yearly.',
      free: {
        title: 'Free pages',
        tag: 'No credit card',
        price: '$0',
        grant: { lead: 'Sign up and get', pages: `${pageCount(FREE_PAGES)} pages`, note: ', about four episodes' },
        items: ["They don't expire", 'Sign up with your email and start translating'],
      },
      plans: EN_PLANS,
      note: 'Yearly and quarterly include exactly the same; only the billing period differs. Pages reset each month on the day you subscribed. Prices are in US dollars and are what your card is charged.',
      start: {
        steps: [
          { title: 'Add to Chrome', body: 'Install it from the Chrome Web Store' },
          { title: 'Sign up with email', body: `Get ${pageCount(FREE_PAGES)} free pages right away` },
          { title: 'Subscribe if you want more', body: 'Choose quarterly or yearly in the extension, then pay' },
        ],
        cta: 'Add to Chrome, start free',
        installed: 'Already installed? Right-click the Naruhodo icon on the toolbar and choose 帳號與訂閱 (Account and subscription).',
      },
      ownKey: 'Already have an Anthropic API key? You can use your own key instead: no account, no page limit.',
    },
    faq: {
      title: 'FAQ',
      discussions: 'community forum',
      items: [
        {
          q: 'How does Naruhodo handle manga pages?',
          a: 'Finding balloons and recognizing text happen on your computer. The recognized Japanese text is sent for translation. See the {link} for details.',
          link: 'privacy',
        },
        {
          q: 'Does Naruhodo store or share the manga I read?',
          a: "No. Manga images never leave your computer; only the recognized Japanese text is sent for translation. Translations are kept in your own browser, so a page you come back to doesn't need translating again.",
        },
        { q: 'What counts as a page?', a: 'Each page translated successfully counts once, including one you ask to translate again; a two-page spread counts as two. Revisiting a translated page or a failed translation does not count.' },
        { q: 'Can I get a refund?', a: 'See the {link}.', link: 'refund' },
        {
          q: 'Where does it work?',
          a: "Naruhodo looks for the large manga image on the page, recognizes the text in it and translates it, so it isn't tied to particular sites. Every site lays out pages a little differently; if a page doesn't translate, let us know in the {link}.",
          link: 'discussions',
        },
      ],
    },
    legal: {
      terms: 'Terms',
      refund: 'Refund Policy',
      privacy: 'Privacy Policy',
      englishOnly: '',
      source: 'Source code',
      discussions: 'Community',
    },
    checkout: {
      title: 'Checkout',
      loading: 'Opening checkout…',
      hint: 'Payment is handled by Paddle. Naruhodo never sees your card number.',
      closed: 'The checkout was closed.',
      reopen: 'Open checkout again',
      completed: 'Payment complete. Taking you back to the extension…',
      slow: 'If nothing happens, you can just close this tab.',
      cancel: 'Changed your mind? Just close this tab to go back to the extension.',
      failed: 'Checkout failed to load. Check your connection and try again.',
      retry: 'Try again',
      missing: 'This checkout link is incomplete. Go back to the extension and open the checkout again.',
      plan: 'Naruhodo subscription',
      pagesPerMonth: 'Pages per month',
      pagesValue: `${pageCount(MONTHLY_PAGES)} pages`,
      refundLabel: 'Refunds',
      refund: `Full refund within ${REFUND_WINDOW_DAYS} days of each payment`,
      agree: 'By paying you agree to the',
    },
  },
};
