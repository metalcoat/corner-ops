#!/usr/bin/env bash
# Adds a staging-only owner account (never in production) to a staging database
# container, so pages and APIs can be checked. Its login is kept in
# /opt/corner-ops/staging/test-owner (readable only by you).
set -Eeuo pipefail
container="${1:-corner-ops-staging-postgres}"
[[ "$container" == corner-ops-staging-* || "$container" == corner-ops-prodref-* ]] || { echo "Only staging databases." >&2; exit 1; }
creds=/opt/corner-ops/staging/test-owner
if [[ ! -f "$creds" ]]; then
  (umask 077; printf 'staging-test@localhost.invalid\n%s\n' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" > "$creds")
fi
node -e '
const { scryptSync, randomBytes } = require("crypto");
const [email, pw] = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
const salt = randomBytes(16).toString("base64url");
console.log(`INSERT INTO app_users (id,email,display_name,role,businesses,password_salt,password_hash,legacy_owner,active,created_by,session_version)
  VALUES (gen_random_uuid(),$$${email}$$,$$Staging test$$,$$Owner$$,ARRAY[$$Corner Deli$$,$$Tiki$$],$$${salt}$$,$$${scryptSync(pw, salt, 64).toString("base64url")}$$,false,true,$$staging$$,1)
  ON CONFLICT DO NOTHING;`);' "$creds" | docker exec -i "$container" psql -U cornerops -d cornerops -q
echo "Staging test owner ready in $container (login in $creds)."
