# Glossary

**Series** (作品)
A single manga title, e.g. one ongoing work, regardless of which site it is read on.
_Avoid_: book, comic, manga (when meaning one title)

**Provisional Series** (臨時作品)
A Series created automatically when translation starts with no Series chosen. It behaves like any other Series until the reader names it or merges it into an existing one.
_Avoid_: unsorted, inbox

**Episode** (話)
One installment of a Series, as published.
_Avoid_: chapter (unless the site itself uses it), issue

**Page** (頁)
One manga page image as the reader sees it on the site. The same Page read on different sites is still one Page. A Page can be taller than the screen, as in vertically scrolled works where the reader scrolls through it; it is still one Page.
_Avoid_: image, screen

**Spread** (跨頁 / 見開き)
Two Pages shown side by side as the reader sees them.
_Avoid_: double page, two-page view

**Panel** (格 / コマ)
One frame of a Page, bounded by panel borders.
_Avoid_: frame, cell

**Balloon** (對話框)
A speech or thought bubble within a Panel that contains dialogue. Text outside Balloons (sound effects, narration, signs) is not a Balloon.
_Avoid_: bubble, text box

**Loose Text** (框外文字)
Text on a Page that belongs to no Balloon: sound effects, narration, signs.
_Avoid_: SFX (only one kind of Loose Text), stray text

**Sound Effect** (狀聲詞)
Loose Text that renders a sound or a manner (擬音語・擬態語), e.g. ぱち, ニコリ. Left as drawn on the Page; its translation shows only in the tooltip and the side panel. A character's own exclamation (あ…, あっ) is speech, not a Sound Effect.
_Avoid_: SFX (in the UI), onomatopoeia

**Line** (句)
One Balloon or one Loose Text entry on a Page, as the transcript lists it in reading order; the unit that hover sync and furigana work on. Its id (b1, l1…) is only unique within its Page, so a Line is always named together with its Page.
_Avoid_: item, sentence (one Balloon can hold several sentences)

**Unreadable** (無法辨識)
A Line whose original cannot be trusted or cannot be read: OCR turned it into garble, or the Page draws it to be illegible even to a Japanese reader (a scrawled letter, an invented script). Listed in the side panel with its original but never covered or translated, so the reader sees the Japanese instead of a plausible wrong translation. Stylized Spelling in a Balloon is not Unreadable.
_Avoid_: garbled, OCR error (only one cause), low confidence (only one cause)

**Stylized Spelling** (變體表記)
Dialogue the author writes in non-standard spelling to give a character's voice: mixed or misplaced kana (アなタ だレ), all-katakana speech, stretched sounds. It reads fine to a Japanese reader, so in a Balloon it is translated and covered like any other Line, and the translation may keep the odd voice. In Loose Text it cannot be told apart from garbled ads and title lettering, so there it may still end up Unreadable.
_Avoid_: broken text, garble

**URL Pattern** (網址模式)
A reading-page URL reduced to origin + path (query and hash ignored), remembered against a Series once the reader chooses a non-provisional Series for it. Only used to preselect that Series the next time the extension is activated on the same URL; never activates the extension by itself.
_Avoid_: site rule, domain mapping

**Page Mode** (頁面模式)
A global setting, remembered across tabs and browser restarts, that decides what the manga page itself shows: 閱讀 (the default) covers each Balloon with its translation; 學習 leaves the Japanese original untouched and reveals readings, then the translation, step by step through the hover tooltip. Hover sync and the tooltip work in both.
_Avoid_: learning mode (that is the whole feature), overlay toggle

**Display Level** (顯示層級)
Which parts of every Line the side panel transcript shows, switched once for all Pages. Under the 閱讀 Page Mode it is one of three levels: 只看譯文, 原文＋譯文, 加振り仮名 (the default). Under 學習 it is only a furigana on/off switch; the translation always stays hidden until revealed step by step.
_Avoid_: mode, learning mode (that is the whole feature)

**Series Notes** (作品筆記)
The fixed translations a Series has settled on — names and terms, plus how each character refers to themself, speaks, and addresses others — used to keep translations consistent. The translator accumulates names and terms as it reads; how each character speaks comes only from the reader, since the text alone does not say who is speaking. The reader reviews it and occasionally corrects it. No plot progress. Belongs to the Series, shared across every site the Series is read on.
_Avoid_: context, glossary (ambiguous with this file), dictionary

**Prior Pages** (前頁)
The Pages the reader saw just before the one being translated, in the same tab, with their text and translations; sent along when a Page is translated so the translator can follow the conversation and keep its wording. Includes the Pages on screen that come earlier in reading order, such as the right Page of a Spread for its left Page, and the earlier part of a Page taller than the screen. Follows what the reader actually saw, so after a jump or a page back they are not the previous Pages of the Episode.
_Avoid_: context (that word is avoided for Series Notes), history

**Practice Spread** (試翻跨頁)
Our own original Spread that a newly installed reader translates for the first time, on a page of our website. It is translated for real, like any other Spread, but never counts as Translated Pages.
_Avoid_: demo (that is the simulated showcase on the homepage), sample page

## Accounts and billing

**Hosted Translation** (內建翻譯)
The default way Pages get translated: our service calls the translator and pays for it. Requires an Account and uses up Translated Pages.
_Avoid_: cloud mode, server mode, official API

**Own API Key** (自備金鑰)
The optional, less prominent way Pages get translated: the reader supplies their own Anthropic API key and pays the translator directly. Needs no Account and has no limits.
_Avoid_: BYOK (fine in code and docs, not in the UI), developer mode

**Account** (帳號)
A reader identified by an email address, needed for Hosted Translation. Holds that reader's Free Pages and Subscription, and nothing about what they read.
_Avoid_: user (ambiguous with reader), member, profile

**Translated Page** (已翻譯頁)
The unit every limit counts: one Page whose translation came back from Hosted Translation, including one the reader asked to translate again. Viewing an already translated Page again, a translation that failed, or the Practice Spread is not a Translated Page; a Spread is two.
_Avoid_: credit, token, request

**Free Pages** (免費額度)
The 50 Translated Pages every new Account gets once, roughly two Episodes. Never reset. Not used while a Subscription is active; whatever is left is usable again after it ends.
_Avoid_: trial, free tier, 免費頁數 (in the UI)

**Subscription** (訂閱)
A paid yearly plan on an Account that grants a Monthly Page Limit.
_Avoid_: membership, license

**Monthly Page Limit** (每月頁數上限)
How many Translated Pages a Subscription allows in each month of its year. What is left of it in the current month is shown in the UI as 本月額度.
_Avoid_: quota (when meaning this specific limit), allowance
