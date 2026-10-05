// Some sites (WebstaurantStore) sign you in with a cookie that only lasts until the
// browser closes, so the saved profile alone forgets the sign-in. The sign-in
// script keeps those cookies next to the profile (same private volume), and each
// run puts them back before opening the site.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const file = (profiles, key) => `${profiles}/${key}.session-cookies.json`;

export async function saveSessionCookies(context, profiles, key) {
  const cookies = (await context.cookies()).filter((c) => c.expires === -1);
  writeFileSync(file(profiles, key), JSON.stringify(cookies), { mode: 0o600 });
  chmodSync(file(profiles, key), 0o600);
  return cookies.length;
}

export async function restoreSessionCookies(context, profiles, key) {
  if (!existsSync(file(profiles, key))) return 0;
  try {
    const cookies = JSON.parse(readFileSync(file(profiles, key), "utf8"));
    await context.addCookies(cookies);
    return cookies.length;
  } catch {
    return 0;
  }
}
