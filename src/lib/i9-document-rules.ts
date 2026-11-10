/**
 * Form I-9 document copies. The employee chooses which documents to present: one from List A, or one
 * from List B and one from List C. Corner Ops never asks for specific documents (that would be
 * discrimination under the INA's anti-discrimination rules); the lists below are only choices.
 */
export type I9DocumentList = "A" | "B" | "C";

export const I9_DOCUMENT_CHOICES: Record<I9DocumentList, string[]> = {
  A: ["U.S. Passport or Passport Card", "Permanent Resident Card (Form I-551)", "Employment Authorization Document (Form I-766)", "Foreign passport with Form I-94 or I-551 stamp", "Other List A document"],
  B: ["Driver's license", "State ID card", "School ID with photograph", "Voter registration card", "U.S. Military card or draft record", "Other List B document"],
  C: ["Social Security card (unrestricted)", "U.S. birth certificate (original or certified copy)", "Certification of Birth Abroad (FS-545, DS-1350 or FS-240)", "Native American tribal document", "Employment authorization document issued by DHS", "Other List C document"],
};

export const I9_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const I9_MAX_DOCUMENTS = 6;

export function i9FileProblem(input: { contentType: string; size: number }): string {
  if (!/^image\/(jpeg|png|heic|heif|webp)$|^application\/pdf$/i.test(input.contentType)) return "Upload a photo (JPG, PNG, HEIC) or a PDF.";
  if (!input.size) return "That file is empty.";
  if (input.size > I9_MAX_FILE_BYTES) return "Files can be up to 10 MB. Take the photo again at a lower size.";
  return "";
}

/** One List A document, or a List B and a List C document. */
export function i9DocumentsComplete(lists: I9DocumentList[]): boolean {
  return lists.includes("A") || (lists.includes("B") && lists.includes("C"));
}

export const I9_COPY_NOTE = "Copies don't replace Section 2: a manager must examine the original documents in person within 3 business days of the first day of work (unless the store uses E-Verify's remote alternative procedure). If copies are kept, keep them for every employee, not just some, and keep them with the I-9.";
