# Build Log — CRM 1: Contact Starter

## First tested checkpoint

- Completed the eight screen sketches and the join, renew, and donate flow diagram in `docs/screens/`.
- Added an eight-link menu. Every route has a distinct title and unfinished features say “Not built yet”; no made-up membership or donation totals are shown.
- Built contact entry, SQLite persistence, case-insensitive search, contact details, and visible keyboard focus.
- Manual check: entered C101–C105 using the classroom reference, compared their saved fields, refreshed, and confirmed the five records remained. Alex and ALEX both found C101; Nobody returned no contacts. Blank and spaces-only names were rejected; a valid sixth test contact saved once. The database was returned to five records.
- Checkpoint: [First tested Contact Starter](https://github.com/berdlebrabis/advanced-studies-crm/commit/5bf4ee674484812c2e8637682bcf9ef8dbc41986)

## Improvement: validation announcement

- Problem: The form showed a blank-name error visually, but its polite announcement could be delayed for assistive technology.
- Change: The error uses an assertive alert with atomic announcement semantics.
- Retest: The browser showed “Enter a name.” and focused the Name field while the five-record count stayed unchanged. The automated suite checks direct blank-name requests, count preservation, and the alert markup.
- Checkpoint: [Improved validation announcement](https://github.com/berdlebrabis/advanced-studies-crm/commit/7199dc8936a43c530eeaf01c72502f7e1cc55e0f)

## Run and login

Run `npm install`, then in PowerShell set `$env:PORT = 3001` and run `npm start`. Open <http://localhost:3001>. Login/settings are not implemented, so there are no demo credentials.

## Current verification

The latest automated test output is recorded in `tests/crm1-test-output.txt`; the acceptance checklist is in `tests/crm1-tests.md`.
