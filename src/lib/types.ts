export const businesses = ["Corner Deli", "Tiki"] as const;
export type Business = (typeof businesses)[number];

export const documentStatuses = ["Active", "Needs Review", "Archived"] as const;
export type DocumentStatus = (typeof documentStatuses)[number];

export type DocumentRecord = {
  id: string;
  business: Business;
  title: string;
  category: string;
  documentDate: string;
  status: DocumentStatus;
  notes: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  createdBy: string;
};

export type AuditEvent = {
  id: string;
  business: Business;
  documentId: string | null;
  action: "uploaded" | "updated" | "archived" | "restored" | "deleted";
  actor: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type SessionView = {
  authenticated: boolean;
  configured: boolean;
  missing: string[];
  email?: string;
  businesses?: Business[];
};
