# Plaid environment redeploy

This commit triggers a fresh Preview deployment after Plaid environment variables were added or updated in Vercel.

Expected Preview variables:

- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `PLAID_ENV`

A new deployment is required before the serverless functions can use changed environment values.
