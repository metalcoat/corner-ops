from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

# Repair two generated sections deterministically before typecheck/build.
workforce = ROOT / 'src/app/api/workforce/route.ts'
text = workforce.read_text()
workforce_pattern = r'    if \(action === "week-copy"\) \{.*?    if \(action === "shift-request-review"\) \{'
workforce_replacement = '''    if (action === "week-copy") {
      try {
        return Response.json(await copyScheduleWeekToTarget({
          business,
          sourceWeekStart: String(body.sourceWeekStart || ""),
          targetWeekStart: String(body.targetWeekStart || ""),
          actor: session.displayName,
        }));
      } catch (error) {
        return actionError(error, "The schedule week could not be copied.");
      }
    }

    if (action === "message-send") {
      return Response.json(await sendStaffNotification({
        business,
        recipientEmployeeId: body.recipientEmployeeId ? String(body.recipientEmployeeId) : null,
        body: String(body.body || ""),
        actor: session.displayName,
        sendSms: body.sendSms === true,
      }));
    }

    if (action === "shift-request-review") {'''
updated, count = re.subn(workforce_pattern, lambda _m: workforce_replacement, text, count=1, flags=re.S)
if count != 1:
    raise RuntimeError(f'workforce action block expected once, found {count}')
workforce.write_text(updated)

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
