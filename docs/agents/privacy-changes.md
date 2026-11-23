# Changing what data is sent or kept

Run this checklist when a change touches `worker/migrations/`, what the Worker stores, or what the extension sends off the reader's computer (the bodies in `src/shared/hosted-api.ts`, `src/shared/claude-request.ts`, the series guess). Why the policy is written this way: [ADR 0015](../adr/0015-privacy-policy-in-three-layers-consent-only-on-material-change.md).

## 1. Is it a Material Change?

It is if any of these is true (GLOSSARY: Material Change):

- [ ] It loosens one of the commitments in PRIVACY.md "Our commitments".
- [ ] A new kind of content leaves the reader's computer: images, page addresses, page titles, or anything else that shows what they read. Numbers or flags about the request itself (a count, whether it was a Retranslation) are not a new kind of content, even when the extension has to send them.
- [ ] A new third party receives the reader's data.
- [ ] Data is used beyond providing, protecting, billing for and improving Naruhodo (the extension and the service).
- [ ] Data is kept longer than PRIVACY.md says.

The Worker may store random identifiers the extension generates (a series ID), never series names, page titles or page addresses. Anonymous usage records lose the series ID when the account is deleted (`deleteAccount` in `worker/src/auth.ts`).

## 2. If it is

- Bump that mode's `DATA_CONSENT_VERSION` and rewrite its `CONSENT_CHANGES` in `src/shared/data-consent-version.ts` (`undefined` for a mode the change does not touch).
- Update PRIVACY.md (effective date included) and the consent card text in `src/ui/data-flow.tsx`.
- Add a case to `src/shared/data-consent.test.ts` saying why the previous version no longer counts.

## 3. Either way

- The category text in PRIVACY.md and `src/ui/data-flow.tsx` still covers what is now stored or sent. A new usage record field fits "measurements and classifications of the request itself"; if it does not fit, it is probably a Material Change.
- New data the Worker stores that the extension supplies comes only from fields that only the new extension sends, and is NULL when missing. Counts the Worker takes from the request itself (how many Notes entries or Lines it carried, how many Suspect Lines it asked again) are fine from older extensions too. The Worker cannot see which version the reader agreed to, and older extensions keep calling the newest Worker for days (ADR 0008).
- The migration only adds (CODING_STANDARDS.md).
