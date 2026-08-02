# Corner Ops

A lightweight internal operations dashboard for Corner Deli and Tiki.

## Included in this rebuild

- Business switcher for Corner Deli and Tiki
- Operations dashboard with document counts and recent uploads
- Document vault with search and filters
- Upload form with title, category, date, status, notes, and original filename
- Browser-local persistence for the first working version
- Responsive layout suitable for desktop and phones

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Current storage model

This initial rebuild stores document metadata in the browser with `localStorage`. It deliberately does not upload file bytes yet. The next backend milestone should add authentication, durable object storage, and a database while preserving the existing UI and document model.
