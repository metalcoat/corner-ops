// Headers for serving staff-uploaded photos (avatars, message photos).
// Uploads only check the type the browser declared, so an "image/svg+xml"
// photo with a script would otherwise run on the ops site when opened.
// Only raster types are served as images; anything else downloads, and the
// response may never run scripts or load anything.

const SAFE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);

export function safeImageHeaders(contentType: string | null | undefined): Record<string, string> {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  return {
    "Content-Type": SAFE_IMAGE_TYPES.has(type) ? type : "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  };
}
