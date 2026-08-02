import { ensureSchema, getSql } from "@/lib/db";
import type { Business, DocumentRecord, DocumentStatus } from "@/lib/types";

type DocumentRow = {
  id: string;
  business: Business;
  title: string;
  category: string;
  document_date: string | Date;
  status: DocumentStatus;
  notes: string;
  file_name: string;
  content_type: string;
  size_bytes: string | number;
  blob_url: string;
  blob_pathname: string;
  created_by: string;
  created_at: string | Date;
};

export type StoredDocument = DocumentRecord & {
  blobUrl: string;
  blobPathname: string;
};

function toIsoDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function toIsoDateTime(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    business: row.business,
    title: row.title,
    category: row.category,
    documentDate: toIsoDate(row.document_date),
    status: row.status,
    notes: row.notes,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: toIsoDateTime(row.created_at),
    createdBy: row.created_by,
    blobUrl: row.blob_url,
    blobPathname: row.blob_pathname,
  };
}

export async function listDocuments(business: Business): Promise<DocumentRecord[]> {
  await ensureSchema();
  const rows = (await getSql()`
    SELECT id, business, title, category, document_date, status, notes, file_name,
           content_type, size_bytes, blob_url, blob_pathname, created_by, created_at
    FROM documents
    WHERE business = ${business}
    ORDER BY created_at DESC
  `) as DocumentRow[];
  return rows.map(mapRow);
}

export async function findDocument(id: string): Promise<StoredDocument | null> {
  await ensureSchema();
  const rows = (await getSql()`
    SELECT id, business, title, category, document_date, status, notes, file_name,
           content_type, size_bytes, blob_url, blob_pathname, created_by, created_at
    FROM documents
    WHERE id = ${id}
    LIMIT 1
  `) as DocumentRow[];
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function insertDocument(input: Omit<StoredDocument, "createdAt">): Promise<DocumentRecord> {
  await ensureSchema();
  const rows = (await getSql()`
    INSERT INTO documents (
      id, business, title, category, document_date, status, notes, file_name,
      content_type, size_bytes, blob_url, blob_pathname, created_by
    ) VALUES (
      ${input.id}, ${input.business}, ${input.title}, ${input.category}, ${input.documentDate},
      ${input.status}, ${input.notes}, ${input.fileName}, ${input.contentType}, ${input.sizeBytes},
      ${input.blobUrl}, ${input.blobPathname}, ${input.createdBy}
    )
    RETURNING id, business, title, category, document_date, status, notes, file_name,
              content_type, size_bytes, blob_url, blob_pathname, created_by, created_at
  `) as DocumentRow[];
  return mapRow(rows[0]);
}

export async function removeDocument(id: string): Promise<StoredDocument | null> {
  await ensureSchema();
  const rows = (await getSql()`
    DELETE FROM documents
    WHERE id = ${id}
    RETURNING id, business, title, category, document_date, status, notes, file_name,
              content_type, size_bytes, blob_url, blob_pathname, created_by, created_at
  `) as DocumentRow[];
  return rows[0] ? mapRow(rows[0]) : null;
}
