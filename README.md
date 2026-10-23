# Advanced Studies CRM — CRM 1: Contact Starter

A small local nonprofit CRM built with Node.js, Express, SQLite, and plain browser HTML, CSS, and JavaScript.

## Start the app

Install the dependencies, then run:

```sh
npm install
npm start
```

Open <http://localhost:3000>. The app stores its local database at `data/crm.sqlite`. The supplied class JSON is reference data; only contacts entered in the app are saved.

## Current scope

Task 1 screen sketches are in `docs/screens/`. The first working slice focuses on contact entry, search, and a small dashboard. Unfinished screens say “Not built yet.” The classroom records are fictional.

## Three next changes

1. Build membership entry and renewals using the real contact records.
2. Build donation entry and saved-gift history.
3. Add tasks, reports, and export workflows, then finish login and settings.