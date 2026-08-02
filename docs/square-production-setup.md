# Square production setup

Corner Ops uses Square OAuth for the Tiki business.

Configure these Vercel environment variables for the Preview environment while testing the feature branch:

- `SQUARE_APPLICATION_ID`
- `SQUARE_APPLICATION_SECRET`
- `SQUARE_ENV=production`
- `SQUARE_API_VERSION=2026-07-15`

Register the active Corner Ops deployment URL plus `/api/square/callback` in the Production OAuth settings of the Square Developer Dashboard.

After changing Vercel environment variables, create a new deployment so the serverless functions receive the updated values.

Latest credential refresh redeployment triggered: 2026-08-02 18:10 America/New_York.
