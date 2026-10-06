# CMS visual QA

Method: a Playwright sweep (`tests/e2e/responsive.spec.ts`, committed) renders every built page at 360, 390, 768, 1024 and
1440 px against the mock backend, fails on horizontal page overflow or a missing/duplicate `h1`, and (with `CMS_SHOTS=<dir>`)
saves full-page screenshots. A person reviewed a sample of the screenshots. Mock data only.

| Check                                                                                 | Result                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 22 pages x 5 widths: no horizontal page overflow                                      | PASS (after fixing 360 px imports/media)                           |
| Exactly one `h1` per page                                                             | PASS                                                               |
| Drawer toggle hidden on desktop, shown at 390                                         | PASS (a desktop bug where `.btn` re-showed it was found and fixed) |
| Closed mobile drawer links not focusable; open ones are; Escape closes                | PASS                                                               |
| Wide tables scroll inside their own labelled region instead of the page               | PASS (visual)                                                      |
| KPI cards use 2 columns on phones                                                     | PASS (after fix)                                                   |
| Reviewed screenshots: dashboard 1440 and 390, order detail 390, profile & access 1024 | Clean, consistent green/neutral design, no clipped text            |

Not done: screenshots of every state (errors, dialogs, empty states) at every width; dark-mode review; contrast audit with a
tool; screen-reader pass with real assistive technology; Safari/Firefox; real data volumes (long titles, 1,000+ rows).
Keyboard behaviour is covered by tests (drawer, `/` shortcut, dialogs on native `<dialog>`), not by a manual audit.
