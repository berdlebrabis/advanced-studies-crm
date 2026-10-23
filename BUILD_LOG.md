# Build Log — CRM 1: Contact Starter

## First running version

- Work: Eight screen sketches and join, renew, and donate flow arrows; an eight-link menu with honest unfinished screens; contact entry with classroom IDs and household links; live saved-record totals; case-insensitive search; blank-name validation; and keyboard-visible focus.
- Test: Opened every menu link and confirmed its screen title. Entered C101–C105 through the form, opened all five records and compared their fields with the class JSON, refreshed, and confirmed they remained. Search for Alex and ALEX both returned C101; Nobody showed the no-results message. Blank and spaces-only names showed “Enter a name.” with the count still five; a valid C900 save made six. The database was reset and C101–C105 were re-entered, leaving five records.
- Automated test: `npm test` passed the case-insensitive search, blank-name API rejection/count unchanged, and one-save/one-contact checks.
- Checkpoint: [First tested Contact Starter](https://github.com/berdlebrabis/advanced-studies-crm/commit/5bf4ee674484812c2e8637682bcf9ef8dbc41986)

## Improvement: announce validation errors promptly

- Problem observed: The blank-name message appeared visually and focus returned to the Name field, but the form placed the error in a polite status region. Assistive technology could defer the message while speaking other content.
- Change: The form error region now uses `role="alert"`, `aria-live="assertive"`, and `aria-atomic="true"` so the complete validation message is announced promptly.
- Repeated test: Submitted C900 with a blank name again. The form displayed “Enter a name.”, returned focus to Name, and kept the saved-contact count at five. The automated test also sends blank and spaces-only names directly to Express and verifies HTTP 400 plus no count change. A markup assertion confirms the assertive alert semantics. `npm test` passed all five tests.
- Checkpoint: [Improved validation announcement](https://github.com/berdlebrabis/advanced-studies-crm/commit/7199dc8936a43c530eeaf01c72502f7e1cc55e0f)

## Screen file check

The XML check found an unescaped ampersand in the Login / Settings sketch. It is now escaped as &amp;; all eight screen sketches and the flow diagram parse successfully.

## Run note

Port 3000 is occupied by an older local CRM process in this workspace. Run this version on port 3001 with `$env:PORT = 3001` before `npm start`, then open <http://localhost:3001>.
