# CRM 1 — Contact Starter test record

**Build:** CRM 1 — Contact Starter
**Tested:** 2026-10-22
**App:** `http://127.0.0.1:3001`
**Demo video:** [Watch the CRM 1 demo recording](https://github.com/berdlebrabis/advanced-studies-crm/blob/main/tests/crm1-demo.mp4) (MP4 file in this repository).

## Task 1 — Draw the app before coding

**Starting data:** The eight required screen descriptions and the join, renew, and donate job requirements from the CRM 1 assignment.
**Steps:** Open `docs/screens/`; inspect each named SVG and `user-flows.svg`; compare the sketches with the task directions.
**Expected:** Eight labeled screen sketches, fields/buttons/information shown on each, three jobs with clear arrows from start to result, unfinished items labeled, and three next changes listed.
**Actual:** Eight screen files are present: Dashboard, Contacts, Contact Details, Memberships, Donations, Tasks, Reports, and Login/Settings. The flow sketch shows Join, Renew, and Donate. The README lists three next changes. Unbuilt functions are identified as unfinished.
**Code checkpoint:** [First tested Contact Starter — `5bf4ee6`](https://github.com/berdlebrabis/advanced-studies-crm/commit/5bf4ee674484812c2e8637682bcf9ef8dbc41986)

## Task 2 — Make the menu

**Starting data:** Running app on port 3001 with five saved classroom contacts; no memberships, gifts, or tasks saved.
**Steps:** Open the app. Use Enter on each of the eight menu links: Dashboard, Contacts, Contact Details, Memberships, Donations, Tasks, Reports, Login / Settings.
**Expected:** Each link opens its matching screen, displays the matching title, marks that link selected, and clearly labels unfinished features without invented totals.
**Actual:** All eight keyboard activations displayed the matching page heading and set the selected link's `aria-current="page"`. Memberships, Donations, Tasks, Reports, and Login / Settings show “Not built yet.” Dashboard numbers come from saved records; no sample giving or membership totals are presented as real results. `Invoke-WebRequest http://127.0.0.1:3001/` returned HTTP 200.
**Code checkpoint:** [First tested Contact Starter — `5bf4ee6`](https://github.com/berdlebrabis/advanced-studies-crm/commit/5bf4ee674484812c2e8637682bcf9ef8dbc41986)

## Task 3 — Save five contacts

**Starting data:** Empty CRM database before the classroom entry exercise; `data/crm-classroom-test-data.json` used as reference. Contact IDs and household IDs are preserved.
**Steps:** Enter C101–C105 once each through Add Contact; open each saved record; compare every form value with the reference; refresh and recheck the table.
**Expected:** Five records, one per save, with matching ID, name, email, phone, household, tags, notes, and email permission; all five persist after refresh.
**Actual:** The running database contains exactly five contacts. Opened record details and compared them with the classroom file. Current saved values are:

| ID | Name | Email | Phone | Household | Tags | Email permission |
|---|---|---|---|---|---|---|
| C101 | Alex Rivera | person101@example.com | 555-0101 | H101 | member | Yes |
| C102 | Sam Lee | person102@example.com | 555-0102 | H101 | donor | No |
| C103 | Jordan Patel | person103@example.com | 555-0103 | H102 | member | Yes |
| C104 | Casey Park | person104@example.com | 555-0104 | H102 | donor | No |
| C105 | Taylor Kim | person105@example.com | 555-0105 | H103 | member | Yes |

All five records have the reference note “Fake classroom contact.” The visible Contacts count is “Showing 5 of 5 contacts.” Refresh retained the records. Automated test also verifies one valid save creates one record.
**Code checkpoint:** [First tested Contact Starter — `5bf4ee6`](https://github.com/berdlebrabis/advanced-studies-crm/commit/5bf4ee674484812c2e8637682bcf9ef8dbc41986)

## Task 4 — Search and reject blank names

**Starting data:** C101–C105 saved; count five. Test invalid contact uses ID C900 and email `blank.test@example.com`.
**Steps:** Search `Alex`, open the result and inspect details; return and search `ALEX`; search `Nobody`; try a blank name and a spaces-only name; finally submit valid C900 / Test Builder in the automated in-memory test.
**Expected:** Both Alex searches return C101; its details identify Alex Rivera. Nobody returns a clear no-results message. Blank and spaces-only names show “Enter a name.” and do not change contact or household counts. A valid sixth contact saves once.
**Actual:** `Alex` and `ALEX` each returned C101, Alex Rivera. Opened details showed the matching ID, name, email, phone, H101 household, member tag, fake note, and granted email permission. `Nobody` displayed “No contacts found. Try another search.” with 0 of 5 contacts. Blank and whitespace-only form/API submissions displayed/reported “Enter a name.” and left five records; the valid automated C900 request returned HTTP 201 and count six. The local database was restored to C101–C105 (five records).
**Code checkpoint:** [First tested Contact Starter — `5bf4ee6`](https://github.com/berdlebrabis/advanced-studies-crm/commit/5bf4ee674484812c2e8637682bcf9ef8dbc41986)

## Task 5 — Use the form without a mouse

**Starting data:** Running Contacts screen, C101–C105 saved; count five.
**Steps:** Use Tab from the menu into the app; press Enter on menu links; open Add Contact with Enter; Tab through the fields and buttons; use Space on Save with ID C900, email `blank.test@example.com`, and a blank name; cancel with Enter.
**Expected:** Text and controls remain readable; each form field has a visible label; keyboard navigation works; Tab displays a focus outline; blank name is rejected and leaves the count unchanged.
**Actual:** All eight menu links worked with Enter. Tab moved through Contact ID, Name, Email, Phone, Household, Tags, Notes, email permission, Cancel, and Save. Each observed selected control had a 3px solid focus outline. Space activated Save; the form announced “Enter a name.” and focused Name. Enter activated Cancel. The dialog closed and the count remained “Showing 5 of 5 contacts.” Automated source check also confirms labels for all eight controls and the `:focus-visible` outline rule.
**Code checkpoint:** [First tested Contact Starter — `5bf4ee6`](https://github.com/berdlebrabis/advanced-studies-crm/commit/5bf4ee674484812c2e8637682bcf9ef8dbc41986)

## Task 6 — Make and prove one improvement

**Starting data:** First running version at commit `5bf4ee6`; five saved contacts. Blank-name submission produced visible feedback and returned focus to Name, but the message used a polite live region that assistive technology could delay.
**Steps:** Change the form-message semantics; repeat blank-name submission with C900 and a blank name; compare message, focus, and saved-contact count; run automated tests.
**Expected:** The complete error is announced promptly, focus returns to Name, and invalid data is not saved. The later commit contains a real code change and the retest.
**Actual:** `#form-message` uses `role="alert"`, `aria-live="assertive"`, and `aria-atomic="true"`. Retest displayed “Enter a name.”, focused Name, and kept the count at five. Automated tests check HTTP 400 for blank/space-only names and no count/household change.
**First checkpoint:** [First tested Contact Starter — `5bf4ee6`](https://github.com/berdlebrabis/advanced-studies-crm/commit/5bf4ee674484812c2e8637682bcf9ef8dbc41986)
**Improvement checkpoint:** [Validation announcement improvement — `7199dc8`](https://github.com/berdlebrabis/advanced-studies-crm/commit/7199dc8936a43c530eeaf01c72502f7e1cc55e0f)

## Automated tests and preserved failures

Real Node.js test code is in `test/contacts.test.js`; it uses `node:test`, an in-memory SQLite database, and Express API requests. It checks case-insensitive/no-match search, invalid and valid saves, duplicate IDs, assertive form errors, all eight menu-to-title mappings, honest unfinished screens, visible form labels, and keyboard focus styling. The captured run is in `tests/crm1-test-output.txt`. [Expanded test/evidence checkpoint](https://github.com/berdlebrabis/advanced-studies-crm/commit/fa4f2ee7539367b6c6964cff505583fdd956b141).

- Initial run: four API tests were blocked by local loopback `EACCES` before reaching Express. After loopback permission was available, rerun passed; this was an environment restriction, not an app failure.
- New menu assertion: first version mistakenly included decorative icon text in the expected heading. Corrected the test to compare the screen/title mapping; rerun passed.
- Screen sketch validation found an unescaped ampersand in Login / Settings. Escaped it as `&amp;`; all eight SVGs and the flow SVG then parsed successfully.

## Code explanation and saved-result proof

- `server.js`: Express serves the app and validates contact requests. It trims names and rejects blank names before creating a household or contact; SQLite transactions keep related writes together.
- `public/app.js`: `setScreen()` displays the selected screen, updates the title and selected menu link; the form sends contact data to `/api/contacts`, refreshes saved records, and presents validation feedback.
- `public/index.html`: contains the eight menu links, screen titles, labeled contact fields, and honest “Not built yet” copy.
- `public/styles.css`: `:focus-visible` gives keyboard-selected controls a 3px outline.
- `test/contacts.test.js`: exercises HTTP validation and persistence against an in-memory database; the saved UI/database result for this run is five contacts, C101–C105.

## Outstanding evidence and next steps

- Demo video: [CRM 1 demo recording](https://github.com/berdlebrabis/advanced-studies-crm/blob/main/tests/crm1-demo.mp4).
- The private repository collaborator check reports `timmb-ecta` has read access.
- Memberships, donations, tasks, reports, and login/settings remain unfinished. Next build memberships and renewals, then donations, then tasks/reports/export and access settings.

