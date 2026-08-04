const REZKU_FILE_HOST = "files.reporting.rezkupos.com";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLS_MIME = "application/vnd.ms-excel";
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

type DownloadAttempt = {
  method: string;
  status: number;
  statusText: string;
  server: string;
  cache: string;
  contentType: string;
  body: string;
};

type DownloadResult = {
  bytes: ArrayBuffer;
  method: string;
  contentType: string;
};

function clean(value: unknown, max = 300): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeRezkuUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.hostname !== REZKU_FILE_HOST) {
    throw new Error("Rezku workbook URL was rejected because the host was not trusted.");
  }
  if (!/\.(xlsx|xls)$/i.test(url.pathname)) {
    throw new Error("Rezku workbook URL did not point to an Excel file.");
  }
  return url;
}

function responseAttempt(method: string, response: Response, body = ""): DownloadAttempt {
  return {
    method,
    status: response.status,
    statusText: clean(response.statusText, 80),
    server: clean(response.headers.get("server"), 80),
    cache: clean(response.headers.get("x-cache") || response.headers.get("cf-cache-status"), 120),
    contentType: clean(response.headers.get("content-type"), 120),
    body: clean(body, 260),
  };
}

function attemptSummary(attempt: DownloadAttempt): string {
  const details = [
    `${attempt.method}: HTTP ${attempt.status}${attempt.statusText ? ` ${attempt.statusText}` : ""}`,
    attempt.server ? `server=${attempt.server}` : "",
    attempt.cache ? `cache=${attempt.cache}` : "",
    attempt.contentType ? `type=${attempt.contentType}` : "",
    attempt.body ? `response=${attempt.body}` : "",
  ].filter(Boolean);
  return details.join(", ");
}

function looksLikeWorkbook(bytes: Uint8Array, fileName: string): boolean {
  if (/\.xlsx$/i.test(fileName)) {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  }
  return bytes.length >= 8
    && bytes[0] === 0xd0
    && bytes[1] === 0xcf
    && bytes[2] === 0x11
    && bytes[3] === 0xe0;
}

async function responseBytes(response: Response, fileName: string): Promise<ArrayBuffer> {
  const bytes = await response.arrayBuffer();
  const view = new Uint8Array(bytes);
  if (!looksLikeWorkbook(view, fileName)) {
    const contentType = clean(response.headers.get("content-type"), 120);
    throw new Error(`Rezku returned a non-workbook response${contentType ? ` (${contentType})` : ""}.`);
  }
  return bytes;
}

async function failedBody(response: Response): Promise<string> {
  try {
    const contentType = response.headers.get("content-type") || "";
    if (!/text|json|xml|html/i.test(contentType)) return "";
    return clean(await response.text(), 260);
  } catch {
    return "";
  }
}

async function directAttempt(rawUrl: string, fileName: string, method: string, headers: HeadersInit): Promise<DownloadResult | DownloadAttempt> {
  const response = await fetch(rawUrl, {
    method: "GET",
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
    headers,
  });
  if (!response.ok) return responseAttempt(method, response, await failedBody(response));
  try {
    return {
      bytes: await responseBytes(response, fileName),
      method,
      contentType: clean(response.headers.get("content-type"), 120),
    };
  } catch (error) {
    return responseAttempt(method, response, error instanceof Error ? error.message : String(error));
  }
}

async function edgeAttempt(rawUrl: string, fileName: string): Promise<DownloadResult | DownloadAttempt | null> {
  const secret = process.env.CRON_SECRET?.trim();
  const host = process.env.VERCEL_URL?.trim() || process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!secret || !host) return null;

  const endpoint = `https://${host.replace(/^https?:\/\//, "").replace(/\/$/, "")}/api/rezku/download-proxy`;
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: rawUrl, fileName }),
  });
  if (!response.ok) return responseAttempt("edge-browser-proxy", response, await failedBody(response));
  try {
    return {
      bytes: await responseBytes(response, fileName),
      method: "edge-browser-proxy",
      contentType: clean(response.headers.get("content-type"), 120),
    };
  } catch (error) {
    return responseAttempt("edge-browser-proxy", response, error instanceof Error ? error.message : String(error));
  }
}

export async function downloadRezkuWorkbook(rawUrl: string, fileName: string): Promise<DownloadResult> {
  safeRezkuUrl(rawUrl);
  const attempts: DownloadAttempt[] = [];
  const accept = /\.xls$/i.test(fileName) ? XLS_MIME : XLSX_MIME;
  const profiles: Array<{ method: string; headers: HeadersInit }> = [
    {
      method: "browser-mail-link",
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: `${accept},application/octet-stream;q=0.9,*/*;q=0.8`,
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://mail.google.com/",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    },
    {
      method: "browser-direct-download",
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: `${accept},application/octet-stream;q=0.9,*/*;q=0.8`,
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    },
    {
      method: "browser-range-download",
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: `${accept},application/octet-stream;q=0.9,*/*;q=0.8`,
        Range: "bytes=0-",
      },
    },
  ];

  for (const profile of profiles) {
    try {
      const result = await directAttempt(rawUrl, fileName, profile.method, profile.headers);
      if ("bytes" in result) return result;
      attempts.push(result);
    } catch (error) {
      attempts.push({
        method: profile.method,
        status: 0,
        statusText: "request failed",
        server: "",
        cache: "",
        contentType: "",
        body: clean(error instanceof Error ? error.message : String(error), 260),
      });
    }
  }

  try {
    const edge = await edgeAttempt(rawUrl, fileName);
    if (edge && "bytes" in edge) return edge;
    if (edge) attempts.push(edge);
  } catch (error) {
    attempts.push({
      method: "edge-browser-proxy",
      status: 0,
      statusText: "request failed",
      server: "",
      cache: "",
      contentType: "",
      body: clean(error instanceof Error ? error.message : String(error), 260),
    });
  }

  throw new Error(`Rezku download failed for ${fileName}. ${attempts.map(attemptSummary).join(" | ")}`);
}
