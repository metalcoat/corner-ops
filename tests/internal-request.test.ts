import assert from "node:assert/strict";
import test from "node:test";
import { isInternalRequest } from "../src/lib/internal-request.js";

const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });

test("requests made on the box are internal and must not be redirected to HTTPS", () => {
  for (const host of ["127.0.0.1:3000", "localhost:3000", "app:3000", "corner-ops-app:3000", "0.0.0.0:3000", "172.18.0.2:3000", "host.docker.internal:3000", "[::1]:3000", "192.168.1.20:3000"])
    assert.equal(isInternalRequest(headers({ host, "x-forwarded-proto": "http" })), true, host);
});

test("visitors are never treated as internal", () => {
  assert.equal(isInternalRequest(headers({ host: "pos.cornerdeli.example", "x-forwarded-proto": "http" })), false);
  // Through the Cloudflare tunnel, even an internal-looking host header is a visitor.
  assert.equal(isInternalRequest(headers({ host: "app:3000", "cf-connecting-ip": "203.0.113.9" })), false);
  assert.equal(isInternalRequest(headers({ host: "localhost", "cf-visitor": '{"scheme":"http"}' })), false);
});
