from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

# The compliance transformer intentionally uses strict matching, but two earlier generic regex
# replacements lose their captures because its sub() helper emits replacement text literally.
# Repair those generated sections deterministically before typecheck/build.

workforce = ROOT / 'src/app/api/workforce/route.ts'
text = workforce.read_text()
broken = r'\1\n        sendSms: body.sendSms === true,\n      }));'
correct = '''    if (action === "message-send") {
      return Response.json(await sendStaffNotification({
        business,
        recipientEmployeeId: body.recipientEmployeeId ? String(body.recipientEmployeeId) : null,
        body: String(body.body || ""),
        actor: session.displayName,
        sendSms: body.sendSms === true,
      }));
    }'''
if text.count(broken) != 1:
    raise RuntimeError(f'workforce generated target expected once, found {text.count(broken)}')
workforce.write_text(text.replace(broken, correct, 1))

expense = ROOT / 'src/lib/expense-control.ts'
text = expense.read_text()
pattern = r'  if \(!documentAiConfigured\(\)\) return \{ id, status: "Needs Configuration" \};.*?\n}\n\nfunction tokenSet'
replacement = '''  if (!documentAiConfigured()) return { id, status: "Needs Configuration" };
  let parsed: Awaited<ReturnType<typeof processWithDocumentAi>>;
  try {
    parsed = await processWithDocumentAi(input.bytes, input.mimeType);
    await getSql()`
      UPDATE receipt_documents SET
        ocr_status = 'Processed',
        merchant_name = ${clean(parsed.merchant, 240)},
        receipt_date = ${parsed.receiptDate},
        total_amount = ${parsed.totalAmount},
        tax_amount = ${parsed.taxAmount},
        currency = ${parsed.currency || "USD"},
        raw_text = ${parsed.rawText},
        entities = ${JSON.stringify(parsed.entities)}::jsonb,
        ocr_error = '',
        updated_at = NOW()
      WHERE id = ${id}
    `;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getSql()`
      UPDATE receipt_documents SET ocr_status = 'Failed', ocr_error = ${clean(message, 1000)}, updated_at = NOW()
      WHERE id = ${id}
    `;
    return { id, status: "Failed", error: message };
  }

  try {
    await refreshReceiptMatches(input.business);
    return { id, status: "Processed", ...parsed };
  } catch (error) {
    const matchError = error instanceof Error ? error.message : String(error);
    console.error("[expense-control] receipt OCR succeeded but match refresh failed", error);
    return { id, status: "Processed", ...parsed, matchError };
  }
}

function tokenSet'''
updated, count = re.subn(pattern, lambda _m: replacement, text, count=1, flags=re.S)
if count != 1:
    raise RuntimeError(f'expense generated OCR target expected once, found {count}')
expense.write_text(updated)

print('Stage 4 generated-source fixups applied')
