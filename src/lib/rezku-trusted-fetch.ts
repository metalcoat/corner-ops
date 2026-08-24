const REZKU_FILE_HOST = "files.reporting.rezkupos.com";
const MAX_REDIRECTS = 4;

export function trustedRezkuWorkbookUrl(value: string): string {
  const normalized = String(value || "").trim().replace(/[)\]}>.,;]+$/g, "");
  const url = new URL(normalized);
  if (url.protocol !== "https:" || url.hostname !== REZKU_FILE_HOST) {
    throw new Error("Rezku workbook URL was rejected because the host was not trusted.");
  }
  if (!/\.(xlsx|xls)$/i.test(url.pathname)) {
    throw new Error("Rezku workbook URL did not point to an Excel file.");
  }
  return url.toString();
}

function trustedRedirectUrl(value: string, base: string): string {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || url.hostname !== REZKU_FILE_HOST) {
    throw new Error("Rezku download redirect left the trusted report host.");
  }
  return url.toString();
}

export async function fetchTrustedRezkuWorkbook(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  let current = trustedRezkuWorkbookUrl(rawUrl);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error(`Rezku returned redirect HTTP ${response.status} without a Location header.`);
    if (redirectCount === MAX_REDIRECTS) throw new Error("Rezku download exceeded the trusted redirect limit.");
    current = trustedRedirectUrl(location, current);
  }
  throw new Error("Rezku download redirect handling failed.");
}
