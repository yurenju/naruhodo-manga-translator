# Glossary

**Series** (作品)
A single manga title, e.g. one ongoing work, regardless of which site it is read on.
_Avoid_: book, comic, manga (when meaning one title)

**Provisional Series** (臨時作品)
A Series the reader has not confirmed yet. Created automatically when translation starts and neither a URL Pattern nor an Original Title matches an existing Series; named after the Original Title guessed from the page, or "未命名・site・date" when none could be guessed. Automatic classification still matches it like any other Series. Only an explicit action confirms it: 「是」 on the Series card, naming or renaming it, choosing a confirmed Series instead, or merging it into one. Once confirmed it can no longer be the source of a merge.
_Avoid_: unsorted, inbox

**Original Title** (原名)
The title of a Series in its original language, as guessed by the LLM from the page's title text (document title, og:title, first headings), without episode or volume numbers, label, author or site name; subtitles and the names of side stories and sequels are kept. Two pages whose Original Titles are equal after normalization (NFKC, collapsed spaces) belong to the same Series, even on different sites. A Series can have several, recorded when the reader chooses or merges into it. Also the series name sent to the translator. The Chinese translation guessed alongside it is never used for matching; it is the Series card's title and is sent to the translator as the series' Chinese name, so the title is not copied into translations in kana (the reader's own name replaces it once they rename the Series).
_Avoid_: series name (that is what the reader sees), work ID

**Episode** (話)
One installment of a Series, as published.
_Avoid_: chapter (unless the site itself uses it), issue

**Page** (頁)
One manga page image as the reader sees it on the site. The same Page read on different sites is still one Page. A Page can be taller than the screen, as in vertically scrolled works where the reader scrolls through it; it is still one Page. Pages stacked one above another to be scrolled through are still Pages, one image each. The images a site cuts a Strip into are not Pages: the cuts ignore the content. Banners, thumbnails, ads and other images on a site that are not pages of a manga are not Pages, even when they carry Japanese text and even when the reader activated the extension on that tab.
_Avoid_: image, screen

**Strip** (條漫)
A run of images stacked one above another whose content continues across them: one long drawing the site has cut into pieces of a fixed height, read by scrolling. Told apart from Pages stacked vertically by the pixels where two images meet: when the rows on both sides join up and are not blank, the run is a Strip. Until such a join is seen, the run is treated as stacked Pages. A Strip has no Pages of its own, so its text is counted in Lines.
_Avoid_: webtoon, 直式漫畫 (stacked Pages scroll vertically too), long page

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

**Reading** (讀音)
The kana pronunciation of a whole Line, shown as furigana over the kanji of each word the analyzer found, so two words written in kanji side by side each get their own (or as a separate line when it cannot be aligned). Always guessed on the device by a morphological analyzer, never printed on the Page and never asked of the LLM, so every Page gets the same Reading whether or not it is translated and whichever translation path it took. Readings of words with several pronunciations and of counters (3分, 一本) can be wrong, so the transcript marks them as a guess.
_Avoid_: furigana (that is how a Reading is shown), ruby, pronunciation

**Romaji** (羅馬拼音)
A Line's Reading written in Latin letters, shown as one extra line under the original wherever the Reading is shown, in addition to the furigana, never instead of it. Off by default; turned on in the settings, for both Page Modes. Hepburn, split into words with particles on their own and inflections joined to their word, particles written as pronounced (は wa, へ e, を o), long vowels with macrons (ō, ū, ā) except えい and いい, which stay ei and ii (sensei). Every Line that has a Reading has Romaji, Pages translated before it existed included; an Unreadable Line has neither. The original and its Romaji line are both split into these words: hovering a word on either line highlights the same word on the other. Where one furigana run covers two words (a kanji suffix), they count as one word.
_Avoid_: pinyin, 拼音 (that is Mandarin's), romanization (in the UI)

**Unreadable** (無法辨識)
A Line whose original cannot be trusted or cannot be read: OCR turned it into garble, or the Page draws it to be illegible even to a Japanese reader (a scrawled letter, an invented script). Listed in the side panel with its original but never covered or translated, so the reader sees the Japanese instead of a plausible wrong translation. An Unreadable Balloon stays in reading order (it is almost always dialogue the reader is missing); Unreadable Loose Text is mostly signs, ads and lettering, so the transcript folds it into one row at the end of its Page. Stylized Spelling in a Balloon is not Unreadable.
_Avoid_: garbled, OCR error (only one cause), low confidence (only one cause)

**Stylized Spelling** (變體表記)
Dialogue the author writes in non-standard spelling to give a character's voice: mixed or misplaced kana (アなタ だレ), all-katakana speech, stretched sounds. It reads fine to a Japanese reader, so in a Balloon it is translated and covered like any other Line, and the translation may keep the odd voice. In Loose Text it cannot be told apart from garbled ads and title lettering, so there it may still end up Unreadable.
_Avoid_: broken text, garble

**URL Pattern** (網址模式)
A reading-page URL reduced to origin + path (query and hash ignored), remembered against a Series once the reader confirms a Series for it. Only used to preselect that Series the next time the extension is activated on the same URL; never activates the extension by itself. On sites where every Episode has its own URL it only matches when the reader re-reads the same Episode; the Original Title covers the next one.
_Avoid_: site rule, domain mapping

**Page Mode** (頁面模式)
A global setting, remembered across tabs and browser restarts, that decides what the manga page itself shows: 閱讀 (the default) covers each Balloon with its translation; 學習 leaves the Japanese original untouched and reveals readings, then the translation, step by step through the hover tooltip. Besides the settings and the side panel, 閱讀／學習 can also be switched from the extension icon's right-click menu. Hover sync works in both. Under 閱讀 the tooltip only shows while the side panel is closed: with it open, the hovered Line is already highlighted there, so the page marks the Line with its number instead. Under 學習 the tooltip always shows, and carries the same number while the side panel is open. 學習 also hides the side panel transcript's translations (see Display Level). A reader who wants the Japanese left on the page but no step to reveal the translation turns on 「學習模式直接顯示譯文」 in the settings (off by default): under 學習 the tooltip and the transcript then show each translation outright, while the page itself still shows only the original. In the side panel it sits on a row labelled 漫畫頁面, apart from the transcript's own Display Level menu, so each control names what it changes.
_Avoid_: learning mode (that is the whole feature), overlay toggle

**Display Level** (顯示層級)
Which parts of every Line the side panel transcript shows, switched once for all Pages. Under the 閱讀 Page Mode it is one of three levels: 只看譯文, 原文＋譯文, 加上讀音 (the default). Under 學習 it is only a furigana on/off switch; the translation stays hidden until revealed step by step, unless 「學習模式直接顯示譯文」 is on (see Page Mode). Never changes the manga page. Remembered globally like Page Mode (each mode keeps its own choice), and changed from the menu on the transcript's 逐字稿 heading, whose button shows the current choice.
_Avoid_: mode, learning mode (that is the whole feature)

**Side Panel on Activation** (啟動時開側邊欄)
A global setting, remembered like Page Mode, that decides whether activating the extension on a tab also opens the side panel. On by default; changed in the settings (「點圖示時也打開側邊欄」). Pages are translated the same either way; a reader who only wants to read manga turns it off, one learning Japanese keeps it on. When it is off, Chrome's own 「開啟側邊面板」 still opens the side panel of a tab being translated.
_Avoid_: reader mode, learning mode, panel mode

**Series Notes** (角色與用語)
The fixed translations a Series has settled on — names and terms, plus how each character refers to themself, speaks, and addresses others — used to keep translations consistent. The translator accumulates names and terms as it reads; how each character speaks comes only from the reader, since the text alone does not say who is speaking. The reader reviews it and occasionally corrects it. No plot progress. Belongs to the Series, shared across every site the Series is read on.
_Avoid_: context, glossary (ambiguous with this file), dictionary, 作品筆記 (the UI name before #186)

**Notes Entry** (條目)
One name or term in a Series' Series Notes, keyed by its original text, with its reading, translation and, for a character, how they speak. The reader can delete one; the translator may record it again later unless it was made an Excluded Term.
_Avoid_: item, row, note

**Excluded Term** (不記的詞)
An original text the reader asked never to be recorded again when deleting its Notes Entry. The translator no longer adds it to that Series' Series Notes; the reader can restore it, which only allows it to be recorded again and does not bring the deleted Notes Entry back. Belongs to the Series like its Series Notes.
_Avoid_: ignored (that is what the reader does to a suggested change), blacklist, blocked term, deleted entry

**Prior Pages** (前頁)
The Pages the reader saw just before the one being translated, in the same tab, with their text and translations; sent along when a Page is translated so the translator can follow the conversation and keep its wording. Includes the Pages on screen that come earlier in reading order, such as the right Page of a Spread for its left Page, and the earlier part of a Page taller than the screen. Follows what the reader actually saw, so after a jump or a page back they are not the previous Pages of the Episode.
_Avoid_: context (that word is avoided for Series Notes), history

**Retranslation** (重新翻譯)
The reader asking for Pages that are already translated to be translated again; each counts as a Translated Page like the first time. Asked from the side panel, it covers every Page on screen and starts over from recognizing the Page, as if the Page had never been seen, and the result replaces the earlier one; asked from a stale Page's hint, it covers only that Page and keeps its recognized text.
_Avoid_: refresh, redo, rescan

**Suspect Line** (可疑句)
A Line whose translation came back breaking the translation rules (empty, still in kana, with stray English), so it is asked again on its own before the Page is shown; part of the same Translated Page, never a Retranslation.
_Avoid_: retranslated line, re-ask

**Practice Spread** (試翻跨頁)
Our own original Spread that a newly installed reader translates for the first time, on a page of our website. It is translated for real, like any other Spread, but never counts as Translated Pages.
_Avoid_: demo (that is the simulated showcase on the homepage), sample page

**Problem Report** (問題回報)
A report the reader makes from the side panel about the Pages on screen, for debugging: where each Page and Line is and how sure the recognition was, and the setup that produced it. It holds no images and none of the Page's text; the reader says in their own words which Page and Line went wrong. The reader pastes it into Discussions themselves, where it becomes public; the extension sends it nowhere.
_Avoid_: bug report, feedback, issue (issues are GitHub Issues, open only to collaborators)

## Reading sites

How a site lays out its Pages; docs and tests name sites by these kinds, never by their real names.

**Canvas Site** (canvas 網站)
A reading site that draws each Page on its own canvas, one after another.
_Avoid_: the site's real name

**E-book Reader** (電子書閱讀器)
A reading site that shows one composed image covering the whole view, a single Page or a whole Spread, and swaps it to turn pages.
_Avoid_: the reader app's brand name, viewer

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

**Data Use Consent** (資料使用同意)
The reader's agreement to how the current translation mode sends text out of the browser, given after reading that mode's data-flow disclosure and before any text is sent. Kept per mode (Hosted Translation, Own API Key), each with its own version; when a mode's data handling has a Material Change, its version goes up, that mode's earlier consent no longer counts, and the reader is asked again with a one-line summary of what changed. Separate from signing in: an expired consent never signs the reader out of their Account; until they agree again, Pages show only the original and its Reading.
_Avoid_: permission (that is Chrome's), opt-in, terms (that is the 服務條款), consentExpired (as a UI state name)

**Material Change** (重大變更)
A change to how data is handled that the reader agreed to without knowing about: a promise loosened, a new kind of content leaving the reader's computer, a new third party, a use beyond the stated purpose, or data kept longer. New numbers about the requests or about how the reader uses the extension, new settings and rewording are not Material Changes; they go only into the policy's history.
_Avoid_: policy update, data change

**Translated Page** (已翻譯頁)
The unit every limit counts: one Page whose translation came back from Hosted Translation, including one the reader asked to translate again. Viewing an already translated Page again, a translation that failed, or the Practice Spread is not a Translated Page; a Spread is two. A Strip has no Pages, so every 8 Lines translated from it count as one Translated Page, rounded up, the first Line counting the first; blank space and how the site cut the Strip do not matter.
_Avoid_: credit, 點數, token, request

**Free Pages** (免費額度)
The 100 Translated Pages every new Account gets once, roughly four Episodes. Never reset. Not used while a Subscription is active; whatever is left is usable again after it ends.
_Avoid_: trial, free tier, 免費頁數 (in the UI)

**Daily Free Pages Cap** (每日免費額度總量)
The most Free Pages all Accounts together can use in one UTC day, a setting of the Worker. Once it is reached, Accounts that only have Free Pages cannot translate new Pages until 00:00 UTC, even with Free Pages left; their own Free Pages are untouched. Subscriptions, the Practice Spread and the rest of a Page already counted are not affected. Unlike running out of Free Pages, it is never the reader's own limit, so the UI says today's free pages are given out, not that theirs are used up.
_Avoid_: daily limit (sounds per Account), 免費額度用完 (that is the reader's own Free Pages)

**Subscription** (訂閱)
The one paid plan on an Account that grants a Monthly Page Limit, paid either quarterly or yearly. Both Billing Periods give the same Monthly Page Limit; only the price differs.
_Avoid_: membership, license, tier (there is only one plan)

**Billing Period** (扣款週期)
How often a Subscription is charged: every quarter or every year. Never monthly: the payment provider's standard rate only covers charges of US$10 or more, and its fixed fee on every charge would take a large share of a small monthly one. Switching between them takes effect at the next charge, never partway through a period.
_Avoid_: billing cycle (ambiguous with the monthly reset of the Monthly Page Limit), term

**Refund Window** (退款期)
The 14 days after every charge of a Subscription that took money, renewals included (a charge brought to US$0 by a discount has none), during which the reader can get that charge back in full however many Translated Pages they used. An email address's first refund is asked for in the extension; once one has been refunded, later ones are asked for by writing to us, even from a new Account, and the same person refunding again and again may be declined. The Subscription keeps working while the refund is pending and ends once the payment provider approves it, after which whatever Free Pages were left become usable again.
A refund request is *pending* until the payment provider decides, then *refunded* or *rejected*. The Worker's database stores the provider's word for refunded, `approved`, and translates it at the API.
_Avoid_: trial, money-back guarantee (in the UI), cooling-off period

**Monthly Page Limit** (每月頁數上限)
How many Translated Pages a Subscription allows in each month of its Billing Period, whichever Billing Period it has. What is left of it in the current month is shown in the UI as 本月額度.
_Avoid_: quota (when meaning this specific limit), allowance
