# Kitalulus vacancy description: list -> detail click-flow

Captain correction (2026-09-08) to the description extraction landed in PR
#18/#21. The prior `extractVacancyDescription` navigated straight to a
constructed `/vacancy/{vacancyId}` URL — the right URL *shape*, but never
verified as the real, currently-generated link, and blind to a vacancy row
whose detail action moves or disappears. It now reaches the same page by
clicking through the real employer UI, the way a human recruiter would.

## The new flow

`src/kitalulus.ts` `extractVacancyDescription(page, vacancy)`:

1. `page.goto("https://employer.kitalulus.com/vacancy")` — the Lowongan
   listing.
2. Dismiss this page's own onboarding tour (`dismissVacancyListTour`, new) —
   a react-joyride sequence (3x "Lanjut", "SELESAI", "OK") that only appears
   here, is separate from `tooltipsDashbaord`'s dashboard tour and
   `dismissMarketingOverlay`'s "HR LEADER GATHERING" promo, and blocks every
   click on the page via a full-viewport overlay until dismissed through its
   own buttons.
3. Dismiss the floating "Chat Kandidat" marketing widget
   (`dismissChatWidget`, new) — a `<getsitecontrol-widget>` custom element
   with an open shadow root; Playwright's CSS engine pierces it, so
   `page.locator("button.close")` reaches the real close button directly.
4. Find this vacancy's row via its own pending-applicants link:
   `a[href*="vacancy_id={id}"][href*="active_tab_secondary=PENDING"]` (the
   same identifier `extractOpenVacancies` already keys on), then its row's
   last `<td>`'s last `<button>` — the row's "Tindakan" action menu (an
   unlabeled MUI icon button; its accessible name lives on the menu it
   opens, not the button itself, so it's found positionally, scoped to the
   row).
5. Click it, then click the opened menu's `role="menuitem"`, exact text
   "Lihat detail lowongan" — an accessible role+text locator, not the
   generated CSS class or the menu item's SVG icon.
6. `page.waitForURL(... includes '/vacancy/{id}') ` to confirm the real
   detail page loaded, then read the description exactly as before: the
   "Deskripsi pekerjaan" label's associated `<textarea>`, via `inputValue()`
   (its content is the field's value, not rendered child text).

Any missing row, missing action menu, missing "Lihat detail lowongan" item,
navigation timeout, or missing description field degrades to
`{ description: null, detailUrl: null }` (or a null description with a
confirmed `detailUrl` once navigation succeeded) instead of throwing — one
vacancy's description is the cost of a layout change, never the run.

`OpenVacancy` gained `detailUrl` (the real URL the click-flow landed on) and
`pendingApplicantCount` (already computed by `extractOpenVacancies`, just
not previously kept). Both ride into `portal_vacancies.raw` via
`sendToSink`'s `vacancy_raw` as `detail_url` / `pending_applicant_count`,
alongside the existing `location` / `expires_at` / `description` keys — an
additive change to the write-once `raw` blob, not a schema change. `title`
and `location` continue to come from the list card (already reliable, no
regression there), and `raw.description` remains the approved slot per the
PR #18 contract.

## Live verification (2026-09-08)

Two passes against the real, production `employer.kitalulus.com` account
(`db/README.md`/AGENTS.md-documented committed test credentials in
`kitalulus.json`, no production data mutated beyond the scraper's normal
read/write footprint):

**1. Isolated click-flow check** (throwaway Playwright script driving the
actual `KitaLulus` class methods, not reimplemented logic): confirmed the
onboarding-tour sequence, confirmed `button.close` reaches the chat widget
through its shadow root, and confirmed the click-through for two different
vacancies:

| Vacancy | Row action found? | Landed URL | Description extracted? |
|---|---|---|---|
| Staff Gudang - Bengkulu (`xhVcYABe200`) | yes | `/vacancy/xhVcYABe200` | yes (not re-verified for content this pass) |
| Kurir Motor Apotek - Surabaya (`WvjbPK7n0UU`) | yes | `/vacancy/WvjbPK7n0UU` | yes — "KUALIFIKASI: Maksimal usia 45 tahun diutamakan Laki-laki..." (full text, truncated here) |

**2. Full-pipeline controlled run**: `kitalulus.json` temporarily set to
`headless: true, limit: 1` (restored to its original `headless: false,
limit: 0` immediately after — `git diff` on it is clean), ran
`npx ts-node src/server.ts kitalulus` end to end (login -> dashboard tour ->
`extractOpenVacancies` -> `extractVacancyDescription` click-flow ->
pending-applicants -> one candidate's full detail scrape -> Supabase sink
write), `LIMIT=1` so exactly one applicant was written.

Supabase (`scrape.portal_vacancies` / `scrape.portal_candidates`,
`portal=eq.kita_lulus`) before vs. after that run:

| | Before | After |
|---|---|---|
| `portal_vacancies` row count | 150 | 150 (unchanged — write-once, no new row expected since this vacancy was already seen) |
| `portal_candidates` row count | 167 | 167 (unchanged — same candidate matched via the identity ladder, not duplicated) |
| Vacancy `Bo78Mfa13NN` (`Sales TO & Canvass - Bengkulu`) `last_seen_at` | `2026-09-08T06:04:36.242Z` | `2026-09-08T06:36:34.472Z` — bumped, proving the run reached and processed this vacancy through the new click-flow without the pipeline erroring out |
| Vacancy `Bo78Mfa13NN` `raw.description` | already populated (`"Kualifikasi :..."`, from an earlier run) | unchanged (expected: `portal_vacancies.raw` is write-once by design — a re-scrape of an already-seen vacancy only touches `last_seen_at`, never overwrites `raw`, see `db/README.md`/AGENTS.md) |
| Candidate `6f1e23e61a5bae09e628341476c066d5d82d2fe2` (Rahmadewi Roskarlina) `last_seen_at` | `2026-09-08T05:24:17.316Z` | `2026-09-08T06:36:35.033Z` — refreshed via the identity ladder (email match), not duplicated |
| Log | — | no `[VACANCY] Failed to extract description` / `No description field found` warning was emitted for this vacancy — the click-flow ran clean |

No existing "polluted" rows (the pre-existing 40-hex-char-id rows tracked
separately in AGENTS.md, unrelated to this change) were touched or deleted.

The write-once contract meant this particular controlled run couldn't show
a *new* `raw.description` write end-to-end (the target vacancy had already
been scraped once before this branch existed), so the isolated click-flow
check above is the direct evidence for the description text itself; the
full-pipeline run is the evidence that the new code path integrates
cleanly into the real `Scrape()` loop, against the real site, without
regressing the vacancy/candidate/application separation or the write-once
guarantee.

## What shipped

- `src/kitalulus.ts`: `extractVacancyDescription` rewritten as the list ->
  detail click-flow described above; two new helpers
  (`dismissVacancyListTour`, `dismissChatWidget`); `OpenVacancy` gained
  `detailUrl` and `pendingApplicantCount`; `sendToSink`'s `vacancy_raw`
  carries both through.
- `tests/kitalulus.unit.test.ts`: `extractVacancyDescription` describe
  block rewritten for the new flow, with fixture-style cases for normal
  extraction, missing detail link (row not found / kebab not found /
  menu item not found), navigation timeout, and description absent.
- This doc.
