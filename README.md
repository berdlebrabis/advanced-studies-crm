# Advanced Studies CRM — Contact Management

Existing Node.js + Express + SQLite CRM, using the original browser UI and class practice data.

## How to run this app

Install **Node.js 22+** and npm. In the project folder, run:

```powershell
npm install
$env:PORT = 3001
npm start
```

Open **http://localhost:3001** in a browser. On macOS/Linux use `PORT=3001 npm start` instead. The default port without the override is 3000.

Sign in with these **fictional local test accounts only**:

| Username | Password | Access |
| --- | --- | --- |
| admin-demo | demo-admin | Read and edit contacts |
| staff-demo | demo-staff | Read and edit contacts |
| viewer-demo | demo-viewer | Read only |

Open **Login / Settings** and click **Load missing practice contacts**. This adds the 30 fictional contacts and five households from `data/crm-classroom-test-data.json` without overwriting already-saved contacts. Loading twice is safe. To archive C130, open that contact and choose Archive. The active list then shows 29 if the initial 30 are the only contacts. Archived records stay in SQLite and remain retrievable by ID.

Search by name or ID, select a tag, open a contact to see household members, and use Edit / Save / Cancel. The change history is in Login / Settings. Viewer sign-in is read-only, including server-side checks.

**Saved data:** `data/crm.sqlite` (or `CRM_DB_PATH` when set). Normal startup does not reseed or delete data. Keep your local SQLite database out of Git. Never use real contact information with the fixed demo passwords.

## Tests

```powershell
npm test
```

Tests use an in-memory database, not the saved app database. The CRM's original membership, donation, task, and report screens are **not built yet**. User management, settings editing, import of CSV files, export, backup, and restore are **not built yet**. The practice-data loader imports the JSON contacts and households only. The fixed demo sign-in is for classroom practice, not production authentication.
