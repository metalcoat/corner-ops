from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "src/app"
LIB = ROOT / "src/lib"


def add_import(text: str, module: str, names: list[str]) -> str:
    names = sorted(set(names))
    pattern = re.compile(rf'import\s*\{{([^}}]+)\}}\s*from\s*"{re.escape(module)}";')
    match = pattern.search(text)
    if match:
        existing = [x.strip() for x in match.group(1).split(',') if x.strip()]
        merged = sorted(set(existing + names))
        return text[:match.start()] + f'import {{ {", ".join(merged)} }} from "{module}";' + text[match.end():]
    line = f'import {{ {", ".join(names)} }} from "{module}";\n'
    if text.startswith('"use client";\n\n'):
        return '"use client";\n\n' + line + text[len('"use client";\n\n'):]
    if text.startswith('"use client";\n'):
        return '"use client";\n' + line + text[len('"use client";\n'):]
    return line + text


def remove_function(text: str, name: str) -> tuple[str, int]:
    match = re.search(rf'\n(?:async\s+)?function\s+{re.escape(name)}\s*\([^{{]*\)\s*(?::\s*[^{{]+)?\s*\{{', text, re.M)
    if not match:
        return text, 0
    brace = text.find('{', match.start())
    depth = 0
    quote = None
    escaped = False
    for i in range(brace, len(text)):
        ch = text[i]
        if quote:
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == quote:
                quote = None
            continue
        if ch in {'"', "'", '`'}:
            quote = ch
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                end = i + 1
                while end < len(text) and text[end] in ' \t': end += 1
                if end < len(text) and text[end] == '\r': end += 1
                if end < len(text) and text[end] == '\n': end += 1
                return text[:match.start()] + '\n' + text[end:], 1
    raise RuntimeError(f"Unclosed function {name}")


# CO-096: one shared client USD formatter. Keep server accounting rounders semantically separate.
client_money = {
    'ops/bank-accounts/page.tsx': 'formatUsdNullable',
    'ops/finance-operations/page.tsx': 'formatUsd',
    'ops/card-statements/page.tsx': 'formatUsd',
    'ops/workforce/payroll-cost-banner.tsx': 'formatUsd',
    'ops/integrations/page.tsx': 'formatUsd',
    'ops/finance-operations/invoice-ocr/page.tsx': 'formatUsd',
}
for rel, helper in client_money.items():
    path = APP / rel
    text = path.read_text()
    text, removed = remove_function(text, 'money')
    if removed:
        text = re.sub(r'\bmoney\(', f'{helper}(', text)
        text = add_import(text, '@/app/client-format', [helper])
        path.write_text(text)

# The finance action helper is a non-negative accounting normalizer, not a display formatter.
finance = LIB / 'finance-operations-actions.ts'
text = finance.read_text()
if 'function money(' in text:
    text = text.replace('function money(', 'function nonNegativeMoney(', 1)
    text = re.sub(r'\bmoney\(', 'nonNegativeMoney(', text)
    finance.write_text(text)

# CO-006 / CO-096: the two Square paths share purpose-specific integration crypto and cents conversion.
for rel in ['square-control.ts', 'square-report-sync.ts']:
    path = LIB / rel
    text = path.read_text()
    text, removed = remove_function(text, 'money')
    if removed:
        text = re.sub(r'\bmoney\(', 'squareMoneyToDollars(', text)
        text = add_import(text, '@/lib/square-money', ['squareMoneyToDollars'])
    if text.count('numberValue(') == 1:
        text, _ = remove_function(text, 'numberValue')
    path.write_text(text)

square_report = LIB / 'square-report-sync.ts'
text = square_report.read_text()
text = re.sub(r'import \{\s*createCipheriv,\s*createDecipheriv,\s*createHash,\s*randomBytes,\s*\} from "node:crypto";\n', '', text, count=1, flags=re.S)
for name in ['integrationKey', 'encryptSecret', 'decryptSecret']:
    text, _ = remove_function(text, name)
text = add_import(text, '@/lib/integration-crypto', [
    'decryptIntegrationSecret as decryptSecret',
    'encryptIntegrationSecret as encryptSecret',
])
square_report.write_text(text)

# CO-096: share low-level Canvas drawing/blob/image loading while preserving each feature's algorithm.
profile = APP / 'employee/profile-photo-optimizer.tsx'
text = profile.read_text()
for name in ['loadImage', 'canvasBlob']:
    text, _ = remove_function(text, name)
text = text.replace('const image = await loadImage(file);', 'const image = await loadImageFile(file, "This photo could not be opened on the device.");')
text = text.replace(
    'context.drawImage(image, sourceX, sourceY, crop, crop, 0, 0, ICON_SIZE, ICON_SIZE);',
    'drawCanvasImage(context, image, { x: sourceX, y: sourceY, width: crop, height: crop }, { x: 0, y: 0, width: ICON_SIZE, height: ICON_SIZE });',
)
text = text.replace(
    'const blob = await canvasBlob(canvas);',
    'const blob = await canvasToJpegBlob(canvas, JPEG_QUALITY, "This photo could not be resized.");',
)
text = add_import(text, '@/app/client-image', ['canvasToJpegBlob', 'drawCanvasImage', 'loadImageFile'])
profile.write_text(text)

messages = APP / 'employee/messages-dock.tsx'
text = messages.read_text()
text, _ = remove_function(text, 'canvasBlob')
text = text.replace(
    'context.drawImage(image, 0, 0, width, height);',
    'drawCanvasImage(context, image, null, { x: 0, y: 0, width, height });',
)
text = text.replace(
    'const blob = await canvasBlob(canvas, quality);',
    'const blob = await canvasToJpegBlob(canvas, quality, "This photo could not be prepared for upload.");',
)
text = add_import(text, '@/app/client-image', ['canvasToJpegBlob', 'drawCanvasImage'])
messages.write_text(text)

scanner = APP / 'scan/page.tsx'
text = scanner.read_text()
text, _ = remove_function(text, 'canvasBlob')
text = text.replace(
    'context.drawImage(bitmap, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);',
    'drawCanvasImage(context, bitmap, null, { x: -sourceWidth / 2, y: -sourceHeight / 2, width: sourceWidth, height: sourceHeight });',
)
text = text.replace(
    'const blob = await canvasBlob(canvas);',
    'const blob = await canvasToJpegBlob(canvas, 0.92, "The processed image could not be created.");',
)
text = add_import(text, '@/app/client-image', ['canvasToJpegBlob', 'drawCanvasImage'])
scanner.write_text(text)

# CO-074: eliminate per-instance 3CX report caching and per-cold-start task seeding.
board = APP / 'api/deli-board/route.ts'
text = board.read_text()
text = text.replace('import { ensureWorkforceSchema } from "@/lib/workforce";\n', '')
text = re.sub(r'let boardSchemaPromise: Promise<void> \| null = null;\n', '', text)
text = re.sub(r'\nconst DEFAULT_TASKS = \[.*?\] as const;\n', '\n', text, count=1, flags=re.S)
text = re.sub(r'\nlet callFeedCache: CallFeed \| null = null;\nlet callFeedPromise: Promise<CallFeed> \| null = null;\n', '\n', text, count=1)
text = re.sub(r'\nasync function ensureBoardSchema\(\) \{.*?\n\}\n\nasync function loadCallFeed', '\nasync function loadCallFeed', text, count=1, flags=re.S)
replacement = '''async function loadCallFeed(today: string): Promise<CallFeed> {
  const sql = getSql();
  const cached = await sql`
    SELECT payload, expires_at
    FROM deli_board_call_cache
    WHERE work_date = ${today}::date AND expires_at > NOW()
  ` as unknown as Array<{ payload: Omit<CallFeed, "expiresAt">; expires_at: string }>;
  if (cached[0]?.payload) {
    return { ...cached[0].payload, expiresAt: new Date(cached[0].expires_at).getTime() };
  }

  try {
    const report = await threeCxDeliCallReport(today, tomorrowDateKey());
    const payload: Omit<CallFeed, "expiresAt"> = {
      workDate: today,
      calls: report.calls.filter((call) => !call.resolved).slice(0, 8),
      callSummary: {
        unresolved: Number(report.summary.unresolved || 0),
        meaningful: Number(report.summary.meaningful || 0),
        issues: Number(report.summary.issues || 0),
        busy: Number(report.summary.busy || 0),
      },
      callError: "",
    };
    await sql`
      INSERT INTO deli_board_call_cache (work_date, payload, expires_at, updated_at)
      VALUES (${today}::date, ${JSON.stringify(payload)}::jsonb,
        NOW() + (${CALL_FEED_TTL_MS} * INTERVAL '1 millisecond'), NOW())
      ON CONFLICT (work_date) DO UPDATE SET
        payload = EXCLUDED.payload,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `;
    return { ...payload, expiresAt: Date.now() + CALL_FEED_TTL_MS };
  } catch (error) {
    console.error("Deli board 3CX load failed", error);
    const payload: Omit<CallFeed, "expiresAt"> = {
      workDate: today,
      calls: [],
      callSummary: { unresolved: 0, meaningful: 0, issues: 0, busy: 0 },
      callError: "3CX call feed unavailable",
    };
    await sql`
      INSERT INTO deli_board_call_cache (work_date, payload, expires_at, updated_at)
      VALUES (${today}::date, ${JSON.stringify(payload)}::jsonb,
        NOW() + (${CALL_FEED_ERROR_TTL_MS} * INTERVAL '1 millisecond'), NOW())
      ON CONFLICT (work_date) DO UPDATE SET
        payload = EXCLUDED.payload,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `;
    return { ...payload, expiresAt: Date.now() + CALL_FEED_ERROR_TTL_MS };
  }
}

async function loadBoard'''
text, count = re.subn(r'async function loadCallFeed\(today: string\): Promise<CallFeed> \{.*?\n\}\n\nasync function loadBoard', replacement, text, count=1, flags=re.S)
if count != 1:
    raise RuntimeError('Deli board loadCallFeed block not found')
text = text.replace('  await ensureBoardSchema();\n', '')
board.write_text(text)

print('Stage 9 final residual transforms applied')
