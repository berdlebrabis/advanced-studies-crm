# CRM 1 — Contact Starter build log

**Build label:** CRM 1 — Contact Starter
**Last updated:** 2026-10-22
**Current tested code:** [Validation announcement improvement — `7199dc8`](https://github.com/berdlebrabis/advanced-studies-crm/commit/7199dc8936a43c530eeaf01c72502f7e1cc55e0f)
**Expanded task evidence and test checkpoint:** [Commit `fa4f2ee`](https://github.com/berdlebrabis/advanced-studies-crm/commit/fa4f2ee7539367b6c6964cff505583fdd956b141)

## 2026-10-22 — First running version

- **Work:** Eight screen sketches and three job flows; eight-link menu and titled screens; contact form, search, details, SQLite persistence, clear unfinished states, and keyboard-visible focus.
- **Test:** Opened each menu link and confirmed its title. Entered C101–C105 through the form once each, compared saved detail fields with the class JSON, refreshed, and confirmed five remained. Alex and ALEX found C101; Nobody produced the no-results message. Blank and spaces-only names were rejected with the count at five; a valid C900 save produced six. Reset and re-entered C101–C105.
- **Checkpoint:** [First tested Contact Starter](https://github.com/berdlebrabis/advanced-studies-crm/commit/5bf4ee674484812c2e8637682bcf9ef8dbc41986)

## 2026-10-22 — Validation announcement improvement

- **Problem:** The blank-name error was visually present but in a polite live region that could be delayed by assistive technology.
- **Change:** `#form-message` became an atomic assertive alert.
- **Retest:** Blank-name submission again announced “Enter a name.”, focused Name, and kept the five-record count unchanged. Automated API checks reject both blank and spaces-only names without creating records or households.
- **Checkpoint:** [Improved validation announcement](https://github.com/berdlebrabis/advanced-studies-crm/commit/7199dc8936a43c530eeaf01c72502f7e1cc55e0f)

## 2026-10-22 — Evidence and accessibility verification

- **Test:** Verified all eight screen titles and selected states using keyboard Enter; Tab moved across form fields and buttons with a 3px solid focus outline. Space on Save with a blank name announced the validation error and left five contacts. Enter on Cancel closed the dialog without saving.
- **Automated:** Seven Node tests pass. Captured output is `tests/crm1-test-output.txt`; test source is `test/contacts.test.js`. [Evidence and test checkpoint](https://github.com/berdlebrabis/advanced-studies-crm/commit/fa4f2ee7539367b6c6964cff505583fdd956b141).
- **Failures, fixes, and retests:** A loopback `EACCES` blocked the first API test run; after granting local test access, all API tests passed. A menu test initially counted decorative icon text in the screen title; the assertion was corrected to compare each route to its `data-title`, then passed. SVG validation found an unescaped ampersand in Login / Settings; it was changed to `&amp;` and all nine SVG files passed parsing.

## Current run instructions and unfinished work

Use PowerShell: `npm install`, `$env:PORT = 3001`, then `npm start`. Open <http://localhost:3001>. Run `npm test` for the automated suite. Login/settings are not implemented, so no demo credentials exist. Memberships, donations, tasks, and reports are still marked “Not built yet.” Next build memberships/renewals, donations, then tasks/reports/export and login/settings.

See `tests/crm1-tests.md` for the task-by-task starting data, steps, expected and actual results, and commit links. The demo-video URL remains outstanding because no recording URL is available.
