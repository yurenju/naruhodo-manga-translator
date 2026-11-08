import type { Locale } from './locale.ts';

export const REPO_URL = 'https://github.com/yurenju/naruhodo-manga-translator';

/** 「加到 Chrome」：Chrome Web Store 的商品頁；ID 跟 GitHub variable `CWS_EXTENSION_ID` 同一個。 */
export const INSTALL_URL = 'https://chromewebstore.google.com/detail/gadioeddhiophjhefjnfkcfiennghbol';

/** 討論區與聯絡 email 跟外掛共用一份。email 放在頁尾：Paddle 審核網站時要在首頁找得到聯絡方式。 */
export { CONTACT_EMAIL, DISCUSSIONS_URL } from '../../src/ui/links.ts';

export const LEGAL_DOCS =['terms', 'refund', 'privacy'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

/** 法律文件一律英文、只有一個網址；`?lang=` 讓頁首頁尾跟著讀者剛才在看的語言。 */
export function legalHref(doc: LegalDoc, locale: Locale): string {
  return `/${doc}?lang=${locale}`;
}
