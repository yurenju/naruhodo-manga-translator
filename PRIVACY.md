# Naruhodo Privacy Policy

Effective date: 2026-10-31
Publisher: Sad Coder, Inc.

Naruhodo is a Chrome extension that translates Japanese manga on screen into Traditional Chinese, in place. This policy explains what data the extension and the Naruhodo service handle, where the data goes, and how long it is kept.

Naruhodo can translate in two ways. You choose one in the extension's settings, and you can switch at any time:

- **Hosted Translation** (the default): you sign in with your email address. Text is sent to the Naruhodo service, which has it translated by Anthropic. New accounts get 50 free pages; after that, translation requires a yearly subscription, paid through Paddle.
- **Own API Key**: you enter your own Anthropic API key. Your browser sends text directly to Anthropic, and the Naruhodo service is not involved.

The extension contains no analytics, advertising or tracking code.

## Data that stays on your computer

These are processed and stored only inside the extension on your computer, in either mode:

- **Screen captures**: after you click the extension icon or press its shortcut on a tab, the extension captures the visible area of that tab, then detects speech balloons and recognizes the text (OCR) on your computer. **Captures are never uploaded** and are discarded after use.
- **Translation cache**: recognized text, translations and readings of the pages you have translated, so a page you revisit does not need to be translated again.
- **Series and page addresses**: the series you have read, and, when you assign a page to a series, that page's address without the part after `?`, so the extension can recognize the series next time.
- **Series Notes**: per-series names, glossary and notes on how characters speak, and suggested changes to them.
- **Anthropic API key** (Own API Key only): stored in the extension's own local database. Web pages and the script the extension injects into them cannot read it, and it is never included in export files.
- **Sign-in** (Hosted Translation only): your email address and the sign-in token for the Naruhodo service, stored in the same local database as the API key. It is never included in export files.
- **Settings**: which translation mode you use, single-page or two-page spread mode, your progress through the setup pages, whether you dismissed the Hosted Translation hint, and the tabs where you have started the extension.
- **Data consent status**: for each translation mode, whether you agreed to the data-use explanation and which version of it you agreed to.
- **OCR models**: the text-detection and OCR models downloaded from Hugging Face (see below). They contain none of your data.

The export feature writes the translation cache, Series, page addresses and Series Notes to a file you save yourself. Nothing is uploaded.

## Data sent off your computer

All connections use HTTPS.

### Text sent for translation

In both modes, the extension sends, for each page: the Japanese text recognized on that page, the original text and translations of the previous few pages of the same series (to keep translations consistent), the series' Series Notes, and the name you gave the series, so translations can recognize the title and use its official translation. A series you have not named yet (shown as "unsorted", with a name the extension made up from the site and date) is sent without a name. To propose new Series Notes entries, it also sends recognized text with its translation and the current Series Notes. **No images or page addresses are sent.** Before sending anything, the extension explains this and asks for your consent, separately for each mode; nothing is sent before you agree.

- **With Hosted Translation**, this text goes to the Naruhodo service, which passes it to Anthropic with our API key and returns the translation. The request also carries your sign-in token and a random identifier the extension generated for the series. **The Naruhodo service does not store this text or the series name**, and does not pass the series identifier to Anthropic.
- **With Own API Key**, your browser sends this text directly to Anthropic with your API key.

### Third parties

- **Anthropic (api.anthropic.com)**, the translation service. It receives the text described above: from the Naruhodo service under our agreement with Anthropic, or from your browser under your own agreement with Anthropic. See the [Anthropic Privacy Policy](https://www.anthropic.com/legal/privacy).
- **Cloudflare** hosts the Naruhodo service and its database. Like any web host, Cloudflare processes your IP address and the requests you send to the service. See the [Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/).
- **Resend** sends the sign-in code email. It receives your email address and the code. See the [Resend Privacy Policy](https://resend.com/legal/privacy-policy).
- **Paddle (Paddle.com)** is our reseller and Merchant of Record and processes subscription payments. When you subscribe, the checkout opens on the Naruhodo website, and you enter your email address, payment details and billing address directly into Paddle's checkout; this information goes to Paddle, not to us. The Naruhodo service never sends your email address to Paddle: it sends only your account's random identifier (and, to open Paddle's subscription management page, Paddle's own identifiers for your subscription), and Paddle tells the service your subscription's identifiers, status and dates. See the [Paddle Privacy Policy](https://www.paddle.com/legal/privacy).
- **Hugging Face (huggingface.co)**: on first use the extension downloads its text-detection and OCR models from here (about 128 MB, or about 472 MB on computers with WebGPU). This is a plain file download and sends none of your data, although, as with any website, Hugging Face can see your IP address.

The extension connects to nothing else.

## Data the Naruhodo service keeps

Only Hosted Translation uses the Naruhodo service. It keeps:

| Data | Purpose |
|---|---|
| Your email address, a random account identifier, and when the account was created | Your account |
| Sign-in codes not yet used: the email address, a hash of the code, its expiry time and the number of wrong attempts | Signing in. A code is valid for 10 minutes |
| A SHA-256 hash of your email address and how many sign-in codes were tried for it in the past hour | Limiting how many sign-in codes can be tried. Deleted when you sign in. Otherwise the count expires one hour after the first try and is deleted later, the next time anyone requests a sign-in code |
| A hash of each sign-in token, when it was created and last used, and when you signed out | Keeping you signed in. A token stops working after 180 days without use, or when you sign out |
| Free pages remaining; for subscribers, the start of the current monthly period and pages used in it | Your page quota |
| One usage record for each successful translation or Series Notes request: the time, the kind of request, token counts and cost, and for a Series Notes request, which page's translation record it belongs to | Usage and cost accounting. Usage records contain no text, translations, series names or page addresses |
| A SHA-256 hash of each email address that has received free pages, and when | Making sure free pages are given only once per email address |
| Your Paddle subscription and customer identifiers, subscription status, start date, end of the paid period, whether cancellation is scheduled, and the time of the last update from Paddle | Your subscription |
| Identifiers of the payment notifications Paddle has sent, and when they arrived | Processing each notification only once. They contain no account or email information |

The service also uses your IP address and email address to limit how often sign-in codes can be requested and tried. Apart from the hourly count above, it does not store them for this purpose.

The service does not store your payment card, billing address, or the text you translate.

## Retention and deletion

### On your computer

Data on your computer stays until you delete it:

- **Delete** in the Own API Key settings removes your API key.
- **Sign out** in the Hosted Translation settings removes your sign-in from this computer.
- **Clear this series' cache** in the Series Notes page clears the translation cache of **that one series**.
- Series, page addresses, Series Notes, settings and data consent status are deleted only when you remove the extension.
- Removing the extension deletes all of its data.

### On the Naruhodo service

- Your account data is kept until you delete your account.
- When you sign out, the service marks that sign-in token as signed out, and it stops working. If the service cannot be reached when you sign out, the sign-in is still removed from your computer, and the token stops working after 180 days without use. The record of a token that is signed out or has stopped working is deleted later, the next time anyone requests a sign-in code.
- A sign-in code is deleted as soon as it is used. A code that is never used expires after 10 minutes and is deleted later, the next time anyone requests a sign-in code.

**Deleting your account** (Settings → Delete account in the extension):

- If you have a subscription, it is cancelled first: it stays usable until the end of the paid year and will not renew. If a renewal payment has failed and is still being retried, or the subscription is paused, it is cancelled immediately, so no further payment is attempted. **Payments already made are not refunded automatically.** If the cancellation fails, nothing is deleted and you can try again.
- The service then deletes your account, all of your sign-in tokens (signing you out on every computer), your page quota, your usage records, your subscription record, any sign-in code not yet used for your email address, and the count of sign-in codes tried for it.
- The service keeps only the SHA-256 hash of your email address and when it received free pages, so that registering again with the same email address does not give free pages again, plus the payment notification identifiers described above. **After deletion, the service keeps no copy of your email address.**
- Data held by third parties is not deleted by the Naruhodo service: Paddle keeps its customer, subscription and transaction records under its own policy and its legal record-keeping obligations, and Resend keeps its email delivery records under its own policy.
- On your computer, deleting your account only signs you out. The translation cache, Series, Series Notes and settings stay.

For text already sent to Anthropic, see Anthropic's data retention policy.

## Security

All connections use HTTPS. The Naruhodo service stores sign-in codes and sign-in tokens only as SHA-256 hashes. Payment details are handled by Paddle and never reach the Naruhodo service or the extension.

## Limited Use

Naruhodo's use and transfer of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the Limited Use requirements. Data is used only to provide translation and the account and subscription that pay for it; it is not sold, not used for advertising, and not used to determine creditworthiness.

## Your rights

Wherever you live, you can:

- **See your data.** The extension's settings show the email address and plan of your account. To get a copy of everything the Naruhodo service keeps about you, write to us.
- **Correct your data.** Your account holds only your email address. To use a different one, delete the account and sign up with the new address, or write to us.
- **Delete your data.** Delete your account in the extension, as described above, or write to us and we will delete it for you.
- **Take your data with you.** The extension's export feature saves your local data to a file. Write to us for a copy of what the Naruhodo service keeps.
- **Withdraw consent.** Sign out or delete your account (Hosted Translation), or delete your API key (Own API Key). Nothing more is sent after that.

We do not sell or share your personal information for advertising, and we do not make automated decisions about you that have legal or similarly significant effects. If you are in the European Economic Area or the United Kingdom, we process your data to provide the service you asked for and to meet our legal obligations, and you can also complain to your local data protection authority.

We answer requests within 30 days.

## Children

Naruhodo is not directed at children under 13, and we do not knowingly collect personal information from them. If you believe a child under 13 has created an account, write to us and we will delete it.

## Changes to this policy

When our data handling changes, we will update this policy and its effective date, and the extension will explain the change and ask for your consent again before sending any more text. Past versions are available in this file's history on GitHub.

## Contact

Sad Coder, Inc., a Delaware corporation. Questions, or requests about your data: dev@sadcoder.com
