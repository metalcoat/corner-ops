#!/usr/bin/env node
import { secureCookies } from "../src/lib/cookie-security";

const cases = [
  { name: "localHttp", env: { APP_URL: "http://localhost:3000" }, expected: false },
  { name: "httpsProduction", env: { APP_URL: "https://corner-ops.example.com" }, expected: true },
  { name: "missingUrlFailsSecure", env: {}, expected: true },
  { name: "explicitSecure", env: { APP_URL: "http://localhost:3000", COOKIE_SECURE: "true" }, expected: true },
  { name: "explicitInsecure", env: { APP_URL: "https://corner-ops.example.com", COOKIE_SECURE: "false" }, expected: false },
] as const;

const results: Record<string, boolean> = {};
for (const test of cases) {
  const actual = secureCookies(test.env as NodeJS.ProcessEnv);
  if (actual !== test.expected) throw new Error(`${test.name}: expected ${test.expected}, received ${actual}.`);
  results[test.name] = true;
}
console.log(JSON.stringify(results, null, 2));
