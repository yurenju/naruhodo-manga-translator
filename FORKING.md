# Forking Naruhodo

Naruhodo's source code is released under the [MIT License](LICENSE). You are free to fork it, change it, ship it and charge for it, including commercially. This page explains the few things that are not covered by that license, so your fork does not run into them by accident.

The MIT License covers the **code**. It does not cover the Naruhodo **name and brand**, and it does not give access to the Naruhodo **service** we operate. Those are the only places where this guide says "must".

## What you must do

### Keep the license notice

Keep the copyright notice and the full text of the [MIT License](LICENSE) in every copy or substantial portion of the code you distribute. This is the one condition of the license itself.

### Use your own name and icon

If you publish your fork (on the Chrome Web Store, a website, or anywhere else people can install it), do not:

- call it "Naruhodo" or a name that could be confused with it;
- use the Naruhodo icon or other Naruhodo artwork;
- use the `naruhodo.page` domain or its subdomains;
- say or suggest that your fork is the official Naruhodo, or that we made, endorse or support it.

The Naruhodo name and icon belong to Sad Coder, Inc. Stating where your fork came from is fine and welcome, for example "based on Naruhodo" with a link to this repository.

A fork you only run yourself, or that you keep unpublished, can stay as it is.

### Do not use the Naruhodo service

Your fork must not call the Naruhodo translation service (`api.naruhodo.page`). The [Terms of Service](TERMS.md) only allow the service to be used through the official extension.

Be aware that a production build connects to that service by default: `hostedApiUrl` in [`scripts/build.ts`](scripts/build.ts) returns `https://api.naruhodo.page`. Before you publish, either point it at a service you run yourself, or remove Hosted Translation and keep only Own API Key, where the text goes straight from the browser to Anthropic.

### Run your own service as yourself

If you run your own copy of the service in [`worker/`](worker/), you are a separate service provider, and you operate it under your own name. That means:

- your own Cloudflare account, Worker route and D1 database (see [`worker/wrangler.jsonc`](worker/wrangler.jsonc));
- your own Anthropic API key, Paddle account and email sender (`MAIL_FROM`, Resend);
- your own terms, privacy policy and refund policy. Do not reuse [TERMS.md](TERMS.md), [PRIVACY.md](PRIVACY.md), [REFUND.md](REFUND.md) or the website in [`site/`](site/): they are promises made by Sad Coder, Inc. to Naruhodo's users, and we cannot make them on your behalf.

The GitHub Actions workflows in [`.github/workflows/`](.github/workflows/) deploy and release to our accounts. In a fork they will fail without our secrets; disable them or point them at your own accounts.

## What we ask

These are requests, not conditions of the license. We hope you follow them anyway.

- **Say where your fork came from.** A line in your README linking back to this repository helps people find the original and its history.
- **Do not publish translated manga.** Naruhodo is meant for reading manga you already have access to. Translations shared publicly can infringe the rights of the manga's creators and publishers.
- **Report security problems to us privately first.** If you find a vulnerability that also affects Naruhodo, email us before disclosing it.
- **Send improvements back.** Bug fixes and features that would help Naruhodo's users are welcome as issues or pull requests.

## Questions

If you would like to use the Naruhodo name, or are not sure whether something is allowed, email dev@sadcoder.com.
