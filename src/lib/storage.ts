import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getLocalStoragePath, getStorageDriver } from "@/lib/config";

type StorageBody = Blob | ArrayBuffer;
type PutOptions = {
  access: "private" | "public";
  addRandomSuffix?: boolean;
  contentType?: string;
};
type GetOptions = {
  access: "private" | "public";
  ifNoneMatch?: string;
};

export type StoredObject = {
  url: string;
  pathname: string;
  contentType: string;
  size?: number;
  etag: string;
};

export type StorageGetResult = {
  statusCode: 200 | 304;
  stream: ReadableStream<Uint8Array> | null;
  blob: StoredObject;
};

function safePathname(value: string): string {
  const withoutScheme = value.startsWith("local:") ? value.slice("local:".length) : value;
  const normalized = path.posix.normalize(withoutScheme.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("\0")) {
    throw new Error("Invalid local storage pathname.");
  }
  return normalized;
}

function withRandomSuffix(pathname: string): string {
  const extension = path.posix.extname(pathname);
  return `${pathname.slice(0, -extension.length || undefined)}-${randomBytes(8).toString("hex")}${extension}`;
}

function localFilePath(pathname: string): string {
  return path.join(getLocalStoragePath(), safePathname(pathname));
}

async function bodyBytes(body: StorageBody): Promise<Buffer> {
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(body);
}

function localObject(pathname: string, contentType: string, size: number, etag: string): StoredObject {
  return { url: `local:${pathname}`, pathname, contentType, size, etag };
}

export async function put(pathname: string, body: StorageBody, options: PutOptions): Promise<StoredObject> {
  if (getStorageDriver() === "vercel") {
    const blob = await import("@vercel/blob");
    return blob.put(pathname, body, options);
  }

  const storedPathname = safePathname(options.addRandomSuffix ? withRandomSuffix(pathname) : pathname);
  const filePath = localFilePath(storedPathname);
  const bytes = await bodyBytes(body);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes, { flag: "wx" });
  const etag = `\"${createHash("sha256").update(bytes).digest("hex")}\"`;
  return localObject(storedPathname, options.contentType || (body instanceof Blob ? body.type : ""), bytes.length, etag);
}

export async function get(reference: string, options: GetOptions): Promise<StorageGetResult | null> {
  if (getStorageDriver() === "vercel") {
    const blob = await import("@vercel/blob");
    return blob.get(reference, options) as Promise<StorageGetResult | null>;
  }

  const pathname = safePathname(reference);
  const filePath = localFilePath(pathname);
  try {
    const fileStat = await stat(filePath);
    const etag = `W/\"${fileStat.size}-${fileStat.mtimeMs}\"`;
    const stored = localObject(pathname, "", fileStat.size, etag);
    if (options.ifNoneMatch === etag) return { statusCode: 304, stream: null, blob: stored };
    const bytes = await readFile(filePath);
    return {
      statusCode: 200,
      stream: new Blob([bytes]).stream(),
      blob: stored,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function del(reference: string | string[]): Promise<void> {
  if (getStorageDriver() === "vercel") {
    const blob = await import("@vercel/blob");
    await blob.del(reference);
    return;
  }

  const references = Array.isArray(reference) ? reference : [reference];
  await Promise.all(references.map(async (item) => {
    try {
      await unlink(localFilePath(safePathname(item)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }));
}
