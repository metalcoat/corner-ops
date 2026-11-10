import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { decryptFormFile, encryptFormFile } from "@/lib/employment-forms";
import { I9_DOCUMENT_CHOICES, I9_MAX_DOCUMENTS, i9DocumentsComplete, i9FileProblem, type I9DocumentList } from "@/lib/i9-document-rules";
import { ValidationError } from "@/lib/http";
import { get, put } from "@/lib/storage";
import type { Business } from "@/lib/types";

type DocumentRow = { id: string; form_id: string; employee_id: string; business: Business; document_list: I9DocumentList; document_title: string; file_name: string; content_type: string; size_bytes: number; storage_url: string; encryption_iv: string; encryption_tag: string; uploaded_at: string };

async function i9Form(business: Business, formId: string, employeeId?: string) {
  const rows = await getSql()`SELECT id, employee_id, status, form_type FROM employment_forms WHERE id = ${formId} AND business = ${business} AND form_type = 'I9' LIMIT 1` as unknown as Array<{ id: string; employee_id: string; status: string }>;
  const form = rows[0];
  if (!form || (employeeId && form.employee_id !== employeeId)) throw new ValidationError("I-9 not found.");
  return form;
}

export async function listI9Documents(business: Business, formId: string, employeeId?: string) {
  await i9Form(business, formId, employeeId);
  const rows = await getSql()`SELECT id, document_list, document_title, file_name, content_type, size_bytes, uploaded_at FROM employment_form_documents WHERE form_id = ${formId} AND deleted_at IS NULL ORDER BY uploaded_at` as unknown as DocumentRow[];
  const documents = rows.map((row) => ({ id: row.id, list: row.document_list, title: row.document_title, fileName: row.file_name, contentType: row.content_type, size: Number(row.size_bytes), uploadedAt: new Date(row.uploaded_at).toISOString() }));
  return { documents, complete: i9DocumentsComplete(documents.map((document) => document.list)) };
}

/** The employee adds a copy of a document they chose, after Section 1 and before the employer finishes Section 2. */
export async function uploadI9Document(input: { business: Business; employeeId: string; formId: string; list: unknown; title: unknown; file: File }) {
  const form = await i9Form(input.business, input.formId, input.employeeId);
  if (form.status === "Completed" || form.status === "Superseded") throw new ValidationError("This I-9 is finished. Ask your manager if a document needs to change.");
  const list = String(input.list || "").toUpperCase() as I9DocumentList;
  if (!["A", "B", "C"].includes(list)) throw new ValidationError("Choose List A, B or C.");
  const title = String(input.title || "").trim().slice(0, 120);
  if (!I9_DOCUMENT_CHOICES[list].includes(title)) throw new ValidationError("Choose which document this is.");
  const problem = i9FileProblem({ contentType: input.file.type, size: input.file.size });
  if (problem) throw new ValidationError(problem);
  const count = await getSql()`SELECT COUNT(*)::int n FROM employment_form_documents WHERE form_id = ${form.id} AND deleted_at IS NULL` as unknown as Array<{ n: number }>;
  if (Number(count[0]?.n || 0) >= I9_MAX_DOCUMENTS) throw new ValidationError("That's the most copies one I-9 can hold. Remove one first.");
  const encrypted = encryptFormFile(Buffer.from(await input.file.arrayBuffer()));
  const id = randomUUID();
  const stored = await put(`i9-documents/${input.business === "Tiki" ? "tiki" : "corner-deli"}/${input.employeeId}/${id}.bin`, new Blob([new Uint8Array(encrypted.data)]), { access: "private", contentType: "application/octet-stream" });
  await getSql()`
    INSERT INTO employment_form_documents (id, business, form_id, employee_id, document_list, document_title, file_name, content_type, size_bytes, storage_pathname, storage_url, encryption_iv, encryption_tag)
    VALUES (${id}, ${input.business}, ${form.id}, ${input.employeeId}, ${list}, ${title}, ${String(input.file.name || "").slice(0, 200)}, ${input.file.type}, ${input.file.size}, ${stored.pathname}, ${stored.url}, ${encrypted.iv}, ${encrypted.tag})
  `;
  return listI9Documents(input.business, form.id, input.employeeId);
}

export async function removeI9Document(input: { business: Business; employeeId: string; documentId: string }) {
  const rows = await getSql()`
    UPDATE employment_form_documents d SET deleted_at = NOW()
    FROM employment_forms f
    WHERE d.id = ${input.documentId} AND d.employee_id = ${input.employeeId} AND d.business = ${input.business} AND d.deleted_at IS NULL
      AND f.id = d.form_id AND f.status NOT IN ('Completed', 'Superseded')
    RETURNING d.form_id
  ` as unknown as Array<{ form_id: string }>;
  if (!rows[0]) throw new ValidationError("That copy can't be removed.");
  return listI9Documents(input.business, rows[0].form_id, input.employeeId);
}

/** Decrypted file for the manager's I-9 review (or the employee's own). */
export async function readI9Document(input: { business: Business; documentId: string; employeeId?: string }) {
  const rows = await getSql()`SELECT * FROM employment_form_documents WHERE id = ${input.documentId} AND business = ${input.business} AND deleted_at IS NULL LIMIT 1` as unknown as DocumentRow[];
  const row = rows[0];
  if (!row || (input.employeeId && row.employee_id !== input.employeeId)) throw new ValidationError("Document not found.");
  const stored = await get(row.storage_url, { access: "private" });
  if (!stored?.stream) throw new ValidationError("The stored copy is missing.");
  const encrypted = Buffer.from(await new Response(stored.stream).arrayBuffer());
  return { bytes: decryptFormFile(encrypted, row.encryption_iv, row.encryption_tag), contentType: row.content_type, fileName: row.file_name || `${row.document_title}` };
}
