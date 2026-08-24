from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / 'src/proxy.ts'
text = path.read_text()
old_import = 'import { createHmac, timingSafeEqual } from "node:crypto";\n'
new_import = 'import { constantTimeEqual, hmacSignature, legacySessionHmac } from "@/lib/security-keys";\n'
if text.count(old_import) != 1:
    raise RuntimeError('proxy crypto import target not found')
text = text.replace(old_import, new_import, 1)
old_equal = '''function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

'''
if text.count(old_equal) != 1:
    raise RuntimeError('proxy equal helper target not found')
text = text.replace(old_equal, '', 1)
old_token = '''function token(request: NextRequest): Token | null {
  const raw = request.cookies.get(COOKIE_NAME)?.value;
  const secret = process.env.SESSION_SECRET;
  if (!raw || !secret) return null;

  const [encoded, supplied] = raw.split(".");
  if (!encoded || !supplied) return null;

  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!equal(expected, supplied)) return null;

  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Token;
    if (Number(value.expiresAt || 0) <= Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}
'''
new_token = '''function token(request: NextRequest): Token | null {
  const raw = request.cookies.get(COOKIE_NAME)?.value;
  if (!raw || (!process.env.OWNER_SESSION_SECRET && !process.env.SESSION_SECRET)) return null;

  const [encoded, supplied] = raw.split(".");
  if (!encoded || !supplied) return null;

  try {
    const current = hmacSignature(encoded, "owner-session", { envName: "OWNER_SESSION_SECRET" });
    const currentValid = constantTimeEqual(current, supplied);
    const legacyValid = !currentValid && Boolean(process.env.SESSION_SECRET)
      ? constantTimeEqual(legacySessionHmac(encoded), supplied)
      : false;
    if (!currentValid && !legacyValid) return null;

    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Token;
    if (Number(value.expiresAt || 0) <= Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}
'''
if text.count(old_token) != 1:
    raise RuntimeError('proxy token target not found')
text = text.replace(old_token, new_token, 1)
path.write_text(text)
print('Stage 4 proxy transformation applied')
