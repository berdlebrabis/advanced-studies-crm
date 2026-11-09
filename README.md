# Advanced Studies CRM — Contact Manager Practice Build

A small local nonprofit CRM built with Node.js, Express, SQLite, and plain browser HTML, CSS, and JavaScript.

## How to run this app

Requirements: Node.js 20 or newer and npm. In PowerShell, open this project folder, install dependencies, and start the app:

```powershell
npm install
$env:PORT = 3001
npm start
```

Open <http://localhost:3001>. Stop the server with Ctrl+C. Run the automated tests with `npm test`.

The SQLite database stays at `data/crm.sqlite` between runs. Normal startup does not clear saved records. The supplied practice files are kept under `data/client-data-1/data/`; the original `data/crm-classroom-test-data.json` remains untouched. After signing in as admin or staff, choose **Contacts → Load full practice data (30 contacts)**. This adds missing contacts, households, memberships, donations, and manual tasks, without overwriting saved records. It can be repeated safely.

### Fake sign-in accounts

These are local practice accounts; do not reuse their passwords elsewhere.

- **Admin:** `admin-demo` / `AdminDemo2026!`
- **Staff:** `staff-demo` / `StaffDemo2026!`
- **Viewer:** `viewer-demo` / `ViewerDemo2026!`

Admin can manage users, set roles, enable viewer exports, and export files. Staff can add, edit, archive, and import contacts. Viewers can read records; exports are denied until an admin enables them. The API checks permissions on every protected request. Passwords are stored as salted hashes and sessions use HttpOnly cookies.

### Contact and import tools

- Edit preserves the contact ID. Names and other text values are trimmed. Email can be empty; a nonempty email must be valid and unique without regard to case.
- Search contacts by name, ID, email, or phone; filter by tag; select **Show archived** to find archived records. Open a household link to see its people.
- Choose a CSV file, preview each row as New, Duplicate, or Error, then import or cancel. CSV headers must be exactly `contact_id,name,email,phone,household,tags,notes,email_opt_in` in any order. Quoted commas and doubled quotes are supported by `csv-parse`; tags in files are separated by semicolons.
- Existing contact IDs are classified as duplicates before validating other fields, and saved details/history are never replaced. Repeated new IDs, invalid emails/consent, and email collisions are errors. A file with errors saves none; valid files commit their new contacts and households together. Reimporting the same file adds zero records.
- Download contacts CSV with the same active/archive, search, and tag filters as the current list. Download the separate email list only exports active contacts with a nonblank email and email permission set to Yes. Admins can grant or revoke viewer export access in Settings; staff and viewers cannot import.
- File import/export history in Settings includes the actor, filename, time, and row count, including successful imports that add zero contacts.
- Archive hides a person from the active list while keeping the row, notes, household, and related records. Contact change history shows the actor, action, record, and time.

### Memberships

- The practice-data button loads 20 supplied memberships and their payment/coverage history, 20 donations, and 15 manual tasks. It does not create welcome or thank-you jobs for old imported records. Renewal follow-ups for active memberships ending in 1–30 days are created once when staff/admin opens Tasks.
- Add memberships for an individual, student/senior, or household plan. The default plan prices are $35, $30, and $40. Only admins can change those prices; saved memberships retain their price.
- Staff and admins can record renewals. A paid renewal begins at the end of current connected coverage when renewed early, or on its payment date when late. Pending and failed payments do not add coverage.
- Payment codes are unique. Membership history shows saved payments, paid date ranges, and who added or renewed each record. Counts use October 15, 2026 by default; select another date to recalculate active, ending-soon, ended, and pending membership counts and the covered-person count.
- Yearly periods include their start date and exclude their end date. Leap-day renewals use February 28 in a non-leap year.
- Donations can be searched by campaign and inclusive date range. Voided gifts stay visible with the actor and time, but are excluded from totals. New gifts create a thank-you job due seven days later unless already thanked.
- Tasks show contact, type, owner, due date, and status. Staff/admin can add, complete, or cancel open jobs. Completed and cancelled jobs stay in history and are not overdue. New paid memberships create one welcome job due on the start date.
- On **Settings**, admins can download a JSON backup or restore it into a new database under `data/restores/`. Restore leaves the current database in place. Set `CRM_DB_PATH` to that restored SQLite filename when starting a separate app instance to open the copy.
- **Reports** recalculates donation totals by campaign, active memberships, covered people, and overdue tasks from saved records. October 15, 2026 is the default practice date; choose another date to recalculate. Voided gifts and membership fees are excluded from donation totals.

Donation, task, import, export, report setting, and backup changes are written to the audit history with the signed-in account and time.

## Tests

```powershell
npm test
```
