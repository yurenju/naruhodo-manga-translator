# Public repo: no real titles or sites

This repo and its GitHub issues are public. Nothing we publish names a real manga, its characters, authors, publishers or magazines, a real manga site, or an e-book reader or store brand.

Technology vendors and libraries we depend on (Cloudflare, Paddle, Anthropic, Amazon SES, PaddleOCR…) are fine: they are not what readers read.

## Where it applies

Everything that leaves this machine:

- Docs, `GLOSSARY.md`, ADRs, `CLAUDE.md` and `docs/agents/`
- Code: identifiers, file names, comments, test samples, test URLs (use reserved domains such as `manga.example`, `reader.example`)
- Commit messages and branch names
- Issue and PR titles, bodies and comments

Git history and old `prototype/*` and `research/*` branches still hold some real names. They are left as they are: rules apply to what we write from now on.

## What to write instead

- **Sites**: name them by layout, using the terms in `GLOSSARY.md` (Canvas Site, E-book Reader), or just "a real site".
- **Titles**: invent fictional ones for test samples; for a real title seen while debugging, use the audit code from that audit's `findings.md` ("round 1, title B").
- **Concrete observations** (URLs, titles, screenshots, page sizes) stay on this machine: the debug session folders under `%LOCALAPPDATA%\naruhodo\` (see [real-site-debugging.md](real-site-debugging.md)) or your scratchpad. Real names are fine there, and easier to debug with. An issue that needs them gives only the local path.
