# Corner Ops project instructions

## Branch and deployment safety

- Do not merge `main` or deploy production unless the user separately authorizes that exact action.
- Do not modify Cloudflare or expose PostgreSQL. Port 5432 must remain unpublished.
- Do not commit secrets, environment files, credentials, or local test PINs.

## Successful development milestones

After implementation and all required tests pass, complete every successful development milestone in this order:

1. Commit the milestone changes.
2. Push only to `origin/agent/pos-ordering-foundation`.
3. Force-update the local development runtime with `/opt/corner-ops/deploy/update.sh --force`.
4. Run the updater as user `chris`, never as root, and do not use `sudo`.
5. Verify the source and runtime SHAs match with:
   - `git -C /opt/corner-ops/app rev-parse HEAD`
   - `git -C /opt/corner-ops/runtime rev-parse HEAD`
6. Verify health with `curl -fsS http://127.0.0.1:3000/api/health`.
7. Verify PostgreSQL is healthy and port 5432 remains unpublished.

Production deployment and merging `main` remain forbidden unless the user separately authorizes them.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
