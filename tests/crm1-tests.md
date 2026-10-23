# CRM 1 — Contact Starter test record

## Demo video

Demo video link: Not available yet. No video URL was supplied or found in this repository; add the published recording link here when one exists.

## Acceptance checks

- [x] Eight screen sketches and join, renew, and donate flow arrows are saved in `docs/screens/`.
- [x] Eight menu destinations open distinct screens; unfinished areas say “Not built yet” and do not show invented totals.
- [x] C101–C105 can be entered, reviewed against the class JSON, and persist after refresh.
- [x] Alex and ALEX find C101; Nobody returns a no-results response.
- [x] Blank and whitespace-only names are rejected by the UI and the API; invalid requests do not change contact or household counts.
- [x] A valid C900 test contact saves once; the app database was reset to five classroom contacts afterward.
- [x] Keyboard focus is visible and validation errors are announced as alerts.
- [x] Automated tests pass; see `crm1-test-output.txt`.

## Not implemented

Memberships, donations, tasks, reports, and login/settings remain explicitly marked “Not built yet.” No demo login is available.
