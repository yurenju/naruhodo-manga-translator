# Public repo: no real titles or sites

This repo and its GitHub issues are public. Nothing we publish names a real manga, its characters, authors, publishers or magazines, a real manga site, or an e-book reader or store brand.

Technology vendors and libraries we depend on (Cloudflare, Paddle, Anthropic, Amazon SES, PaddleOCR…) are fine: they are not what readers read.

## Where it applies

Everything that leaves this machine:

- Docs, `GLOSSARY.md`, ADRs, `CLAUDE.md` and `docs/agents/`
- Code: identifiers, file names, comments, test samples, test URLs (use reserved domains such as `manga.example`, `reader.example`)
- Commit messages and branch names
- Issue and PR titles, bodies and comments

## Discussions: what users write

[Discussions](https://github.com/yurenju/naruhodo-manga-translator/discussions) is where users report problems and talk to us. What they write there is theirs: a user who names a site or a title is fine, and we don't edit or hide it.

- **An issue made from a Discussion** may quote what that user wrote, names included. Mark it as a quote and link the Discussion.
- **What we find ourselves** while reproducing it (URLs we opened, screenshots, traces) stays on this machine, as below. The issue gives only the local path.
- **Our replies** in a Discussion, and everything else in **Where it applies** (code, commits, branches, PRs, docs, ADRs, `GLOSSARY.md`), still name no site or title, even when the issue it fixes quotes one. Describe the site by layout.

Git history and old `prototype/*` and `research/*` branches still hold some real names. They are left as they are: rules apply to what we write from now on.

## What to write instead

- **Sites**: name them by layout, using the terms in `GLOSSARY.md` (Canvas Site, E-book Reader), or just "a real site".
- **Titles**: invent fictional ones for test samples; for a real title seen while debugging, use the audit code from that audit's `findings.md` ("round 1, title B").
- **Inside a title**: a short line of dialogue may be quoted as evidence of a bug (an OCR misread, a mistranslation). Proper nouns from the title (characters, places, shops, bands, nicknames) are not: write 〇〇 or describe them ("a nickname", "a shop sign").
- **Concrete observations** (URLs, titles, screenshots, page sizes) stay on this machine: the debug session folders under `%LOCALAPPDATA%\naruhodo\` (see [real-site-debugging.md](real-site-debugging.md)) or your scratchpad. Real names are fine there, and easier to debug with. An issue that needs them gives only the local path.
