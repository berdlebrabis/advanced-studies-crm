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

The SQLite database stays at `data/crm.sqlite` between runs. Normal startup does not clear saved records. The supplied practice files are kept under `data/client-data-1/data/`; the original `data/crm-classroom-test-data.json` remains untouched. After signing in as admin or staff, choose **Contacts → Load 30 practice contacts**. The import adds missing IDs and leaves contacts already saved in the database unchanged. It can be repeated safely.

### Fake sign-in accounts

These are local practice accounts; do not reuse their passwords elsewhere.

- **Admin:** `admin-demo` / `AdminDemo2026!`
- **Staff:** `staff-demo` / `StaffDemo2026!`
- **Viewer:** `viewer-demo` / `ViewerDemo2026!`

Admin can manage users, set roles, and export contacts. Staff can add, edit, archive, and import contacts. Viewers can read records. The API checks permissions on every protected request. Passwords are stored as salted hashes and sessions use HttpOnly cookies.

### Contact and import tools

- Edit preserves the contact ID. Names and other text values are trimmed. Email can be empty; a nonempty email must be valid and unique without regard to case.
- Search contacts by name, ID, email, or phone; filter by tag; select **Show archived** to find archived records. Open a household link to see its people.
- The contact CSV importer maps `contact_id` to the contact ID and `household` to the household link. Existing IDs are skipped before other row validation so existing records are not overwritten. Invalid rows show a reason.
- Archive hides a person from the active list while keeping the row, notes, household, and related records. Contact change history shows the actor, action, record, and time.

Membership entry, donations, tasks, and their management screens are not built yet. Existing table slots remain, but the practice-data loader in this build imports contacts and households only.

## Tests

```powershell
npm test
```

