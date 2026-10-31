import type { Locale } from './locale.ts';
import type { LegalDoc } from './links.ts';

/**
 * 網站文案（#89 A 版定稿）。`[TBD]` 會畫成明顯的 TBD 標記（Copy.astro），標在還沒定案的文字旁。
 * 年費、Monthly Page Limit 800 與由它推算的「大約 4 本」在上線時（#97）拿掉了標記：Paddle 審核網站時看到 TBD
 * 會當成還沒完成。數字仍是草案，量完真實成本再調。
 */
export interface SiteCopy {
  nav: { pricing: string; faq: string; install: string; languageLabel: string };
  hero: { title: string; lead: string; install: string; pricing: string };
  /** 首頁互動展示（#109）外框上的文字；展示裡面的外掛介面只有繁體中文 */
  demo: { caption: string; hint: string; replay: string };
  how: { title: string; steps: readonly { title: string; body: string }[] };
  pricing: {
    title: string;
    free: { title: string; items: readonly string[]; cta: string };
    sub: { title: string; price: string; unit: string; items: readonly string[]; cta: string };
    ownKey: string;
  };
  /** `a` 裡的 `{link}` 換成 `link` 那份法律文件的連結 */
  faq: { title: string; items: readonly { q: string; a: string; link?: LegalDoc }[] };
  legal: Record<LegalDoc, string> & { englishOnly: string; source: string };
  checkout: {
    title: string;
    loading: string;
    hint: string;
    closed: string;
    reopen: string;
    completed: string;
    failed: string;
    retry: string;
    missing: string;
    plan: string;
    pagesPerMonth: string;
    pagesValue: string;
    agree: string;
  };
}

const PRICE = '$20';

export const copy: Record<Locale, SiteCopy> = {
  'zh-tw': {
    nav: { pricing: '價格', faq: '常見問題', install: '安裝外掛', languageLabel: '語言' },
    hero: {
      title: '看日文漫畫，旁邊就有中文',
      lead: 'Naruhodo 是一個 Chrome 外掛。點一下圖示，它會找出畫面上的漫畫頁、讀出對話框裡的日文，再把繁體中文翻譯放回原本的位置，還附上振り仮名，邊看邊學日文。',
      install: '加到 Chrome',
      pricing: '看價格',
    },
    demo: {
      caption: '實際操作看看：點右上角的 Naruhodo 圖示，切到「學習」後把滑鼠移到對話框上。',
      hint: '點這裡開始翻譯',
      replay: '重新播放',
    },
    how: {
      title: '怎麼用',
      steps: [
        { title: '安裝並登入', body: '輸入 email，收到驗證碼貼回來就登入，不用設定密碼。' },
        { title: '打開你在看的漫畫', body: '在漫畫頁上點外掛圖示，或按 Alt+Shift+M。' },
        { title: '對照著看', body: '譯文疊在對話框上，原文與讀音都留著；已經翻過的頁面再看不會再算一次。' },
      ],
    },
    pricing: {
      title: '價格',
      free: { title: '免費額度', items: ['註冊就有 50 頁免費額度（大約兩話）', '不需要信用卡'], cta: '免費開始' },
      sub: {
        title: '年繳訂閱',
        price: PRICE,
        unit: '／年',
        items: ['每月 800 頁翻譯，大約 4 本單行本', '每月在你訂閱的那天重置', '隨時取消，用到這一年結束'],
        cta: '訂閱',
      },
      ownKey: '已經有 Anthropic API key？也可以改用自備金鑰，不需要帳號、沒有頁數限制。',
    },
    faq: {
      title: '常見問題',
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
          a: 'Naruhodo 會找出頁面上大張的漫畫圖片，辨識裡面的文字再翻譯，所以不限定特定網站。每個網站的版面不太一樣，如果遇到翻不出來的頁面，歡迎到 GitHub 回報。',
        },
      ],
    },
    legal: {
      terms: '服務條款',
      refund: '退款政策',
      privacy: '隱私權政策',
      englishOnly: '法律文件僅提供英文版本，以英文內容為準。',
      source: '原始碼',
    },
    checkout: {
      title: '付款',
      loading: '正在開啟付款畫面…',
      hint: '付款由 Paddle 處理，Naruhodo 不會看到你的卡號。',
      closed: '付款畫面已經關閉。',
      reopen: '重新開啟付款畫面',
      completed: '付款完成。回到外掛就能開始使用訂閱，這個分頁可以關掉了。',
      failed: '付款畫面沒有成功載入。請檢查網路連線後再試一次。',
      retry: '重新載入',
      missing: '這個付款連結不完整。請回到外掛，重新打開付款頁。',
      plan: 'Naruhodo 年繳訂閱',
      pagesPerMonth: '每月頁數',
      pagesValue: '800',
      agree: '付款即表示同意',
    },
  },
  en: {
    nav: { pricing: 'Pricing', faq: 'FAQ', install: 'Install', languageLabel: 'Language' },
    hero: {
      title: 'Read Japanese manga with Chinese right where the words are',
      lead: 'Naruhodo is a Chrome extension. Click its icon and it finds the manga page on your screen, reads the Japanese in each speech balloon, and places a Traditional Chinese translation right back where the text was, with furigana so you learn Japanese as you read.',
      install: 'Add to Chrome',
      pricing: 'See pricing',
    },
    demo: {
      caption: 'Try it: click the Naruhodo icon at the top right, then switch to 學習 (Study) and hover a balloon.',
      hint: 'Click to translate',
      replay: 'Replay',
    },
    how: {
      title: 'How it works',
      steps: [
        { title: 'Install and sign in', body: 'Enter your email and paste back the code we send. No password needed.' },
        { title: "Open the manga you're reading", body: 'On the page, click the extension icon or press Alt+Shift+M.' },
        { title: 'Read side by side', body: 'Translations sit on the balloons, with the original text and readings kept. Revisiting a translated page never counts again.' },
      ],
    },
    pricing: {
      title: 'Pricing',
      free: { title: 'Free pages', items: ['50 free pages when you sign up (about two episodes)', 'No credit card needed'], cta: 'Start free' },
      sub: {
        title: 'Yearly subscription',
        price: PRICE,
        unit: '/year',
        items: ['800 translated pages a month, about 4 volumes', 'Resets each month on the day you subscribed', 'Cancel anytime, keep using it until the year ends'],
        cta: 'Subscribe',
      },
      ownKey: 'Already have an Anthropic API key? You can use your own key instead: no account, no page limit.',
    },
    faq: {
      title: 'FAQ',
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
          a: "Naruhodo looks for the large manga image on the page, recognizes the text in it and translates it, so it isn't tied to particular sites. Every site lays out pages a little differently; if a page doesn't translate, let us know on GitHub.",
        },
      ],
    },
    legal: {
      terms: 'Terms',
      refund: 'Refund Policy',
      privacy: 'Privacy Policy',
      englishOnly: '',
      source: 'Source code',
    },
    checkout: {
      title: 'Checkout',
      loading: 'Opening checkout…',
      hint: 'Payment is handled by Paddle. Naruhodo never sees your card number.',
      closed: 'The checkout was closed.',
      reopen: 'Open checkout again',
      completed: 'Payment complete. Go back to the extension to start using your subscription; you can close this tab.',
      failed: 'Checkout failed to load. Check your connection and try again.',
      retry: 'Try again',
      missing: 'This checkout link is incomplete. Go back to the extension and open the checkout again.',
      plan: 'Naruhodo yearly subscription',
      pagesPerMonth: 'Pages per month',
      pagesValue: '800',
      agree: 'By paying you agree to the',
    },
  },
};
