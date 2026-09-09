# Crawl4AI / Scrapling extraction evaluation

Bounded evaluation of whether Crawl4AI or Scrapling should supplement the
Playwright-based structured extraction (job title/location/description) in
this repo. **Outcome: no dependency added.** Playwright stays the sole
extraction mechanism; this doc and the fixture tests in
`tests/kitalulus.unit.test.ts` (`extractVacancyDescription` describe block,
tests tagged `[fixture: ...]`) are the durable record of why.

## The gap examined

`src/kitalulus.ts` `extractVacancyDescription` reads the vacancy description
by anchoring on the exact-text label "Deskripsi pekerjaan" and then walking
`xpath=following::textarea[1]` to read the field's `inputValue()`. This
selector was already wrong once in production (PR #18: the original code
read `innerText()` on the label's next sibling, which is empty for a
disabled MUI `<textarea>` — its value isn't in the accessible text tree) and
degrades to a silent `null` on any further structural drift, e.g. if the
description ever moves off a `<textarea>` onto plain text. That drift class
— an anchor label surviving a redesign while the element carrying the value
changes — is the one place in the codebase where a selector-drift-resistant
extractor (Scrapling's pitch) or an LLM-based one (Crawl4AI's pitch) could
plausibly help.

## Why no dependency was added

1. **Both libraries are Python-native; this repo has no Python anywhere in
   its runtime.** `package.json` is 100% Node/TS (`ts-node`, `tsc`), and the
   production `dockerfile` is a pinned Playwright+Node image with no Python
   layer (see the dockerfile header's two pairing rules). Scrapling has no
   JS/Node port. The `crawl4ai` npm package is not the library itself — it's
   a thin REST client for a separately-hosted Python Crawl4AI server, so
   using it here means standing up and operating a whole extra service, not
   adding a library. Either path is an architecture change (new runtime or
   new networked service to keep alive, secure, and deploy), far past the
   "small integration" the task scoped.
2. **The fixture experiment found a real capability but also a real new
   failure mode.** Using a local Python 3.11 venv (kept outside the repo,
   nothing committed to `package.json`), a faithful Python replica of the
   production selector logic (`lxml`, mirroring `getByText(exact) +
   following::textarea[1] + inputValue()`) was run against 4 HTML fixtures —
   normal, missing field, malformed/unclosed tags, and portal drift (label
   present, description moved from `<textarea>` to a `<p>`) — and compared
   against Scrapling's `Adaptor.find_by_text()` on the same fixtures:

   | fixture | current (Playwright-style) logic | Scrapling adaptive lookup |
   |---|---|---|
   | normal | ✅ correct description | ❌ **grabbed the location chip text instead** |
   | missing fields (empty textarea) | ✅ `null` (correct) | ✅ `null` (correct) |
   | malformed HTML (unclosed tags) | `null` (label ends up nested inside its own following-textarea search, degrades safely) | ❌ **grabbed the location chip text instead** |
   | portal drift (textarea → plain text) | `null` (the known gap) | ✅ **recovered the real description** |

   Scrapling's text-anchored, tag-agnostic matching does recover the exact
   drift class this codebase has already been bitten by once. But a
   straightforward "nearest text-bearing neighbor" port, run against real
   fixtures, picked up the *wrong* nearby text (the location chip) on both
   the normal and malformed cases — trading one silent-`null` failure mode
   for a silent-wrong-value one, which is worse for a raw ingestion
   contract. Making the adaptive matcher precise enough (proper anchoring by
   DOM relationship + content scoring, not "first sibling with text") is
   real implementation work, not something a bounded fixture experiment
   demonstrates as a net win.
3. **The codebase already has a dependency-free mitigation for this exact
   drift class, and uses it.** Anchoring extraction on stable visible text
   (`page.getByText(...)`) rather than fragile CSS classes, plus multi-path
   fallback chains (`GLINTS_APPLICANT_ROW_SELECTOR` combines a Polaris class
   selector, a `data-testid`, and a `tbody tr` fallback — see
   `src/glints.ts`), is the same underlying strategy Scrapling/Crawl4AI
   sell, already in place with zero added runtime cost. PR #18 fixed the
   kitalulus regression this way (correct the anchor/selector), not by
   adding an adaptive layer.
4. **Crawl4AI's core value (LLM extraction from noisy/adversarial or
   JS-heavy public pages) doesn't apply to the pages in scope.** All
   extraction here happens on already-authenticated, Playwright-rendered
   dashboard DOM the scraper controls end to end — there's no anti-bot or
   unstructured-content problem to solve, just "did the anchor text survive
   this portal's last redesign," which fallback locators already handle.

## What would change this conclusion

If a portal's real DOM starts drifting in ways that plain text-anchor
fallbacks can't keep up with (e.g. frequent unannounced full markup
rewrites), the fixture harness above (`current_extract.py` /
`scrapling_extract.py`, not committed — see below) is reusable to re-run
this comparison with a properly-scored adaptive matcher instead of the naive
one used here.

## Reproducing the experiment

The Python-side scripts and venv used for the comparison were scratch-only
(outside this repo, nothing added to `package.json`/`requirements`) and are
not committed. To reproduce: create fixtures matching the 4 scenarios in
`tests/kitalulus.unit.test.ts`'s `extractVacancyDescription` `[fixture: ...]`
tests, install `scrapling` and `lxml` in a throwaway venv, and compare
`Adaptor.find_by_text("Deskripsi pekerjaan", ...)` against an `lxml`
replica of the current `getByText(exact) + following::textarea[1]` logic.

## What shipped

- `tests/kitalulus.unit.test.ts`: 4 new fixture-style tests on the real
  `extractVacancyDescription` code path (normal, missing field, malformed
  HTML, portal drift), so the known drift gap is an asserted, tracked
  behavior instead of an undocumented one.
- This doc.
- No new dependency, no `package.json` change, no extraction code change.
