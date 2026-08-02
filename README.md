# Corner Ops

Corner Ops is the internal document system for **Corner Deli** and **Tiki**. The current milestone replaces the browser-only prototype with authenticated, persistent storage.

## What works

- Password-protected owner session using a signed, HTTP-only cookie
- Separate Corner Deli and Tiki document views
- Upload PDF, image, spreadsheet, Word, CSV, and text files up to 20 MB
- Store metadata in Neon Postgres
- Store original files in a private Vercel Blob store
- Search and filter by title, category, filename, notes, and status
- Authenticated file downloads streamed through the app
- Edit document metadata and status
- Archive and restore records before permanent deletion
- Delete both the database record and private stored file
- Record uploads, edits, archives, restores, and deletions in an audit trail
- Automatic database table/index creation on the first request
- Friendly setup screen when required environment variables are missing

## Stack

- Next.js 16 App Router
- React 19 and TypeScript
- Neon Postgres via `@neondatabase/serverless`
- Private Vercel Blob storage via `@vercel/blob`
- Vercel or any Node 22 hosting environment

## Vercel setup

1. Import `metalcoat/corner-ops` into Vercel.
2. In the project **Storage** tab, connect a Neon Postgres database.
3. Create and connect a **Private** Vercel Blob store.
4. Add these project environment variables:

   - `APP_EMAIL=crfrary@gmail.com`
   - `APP_PASSWORD=<a long unique password>`
   - `SESSION_SECRET=<at least 32 random characters>`

Neon supplies `DATABASE_URL`; Blob supplies `BLOB_READ_WRITE_TOKEN`. Deploy again after all variables are present.

The `documents` and `audit_events` tables are created automatically. The equivalent SQL is kept in `db/schema.sql` for inspection or manual setup.

## Local development

Local development still uses the connected Neon and Blob resources:

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`.

## Validation

```bash
npm run typecheck
npm run build
```

GitHub Actions runs both checks for every pull request and push to `main`.

## Security notes

- Files are uploaded to a private Blob store and are never linked directly in the UI.
- Every list, upload, edit, delete, and download route validates the signed session and business access.
- Private downloads use `Cache-Control: private, no-cache` and are streamed through an authenticated route.
- Password comparison uses constant-time comparison.
- Permanent deletion is blocked until a record has been archived.
- This milestone intentionally supports one owner account. Multi-user invitations and role management belong in the next milestone.

## Next milestones

1. User invitations and employee roles
2. OCR and automatic document classification
3. Email/scan inbox ingestion
4. Exportable audit reports and retention rules
5. Dashboard tasks, expiration reminders, and reports
