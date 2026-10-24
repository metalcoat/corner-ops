import { readFile } from "node:fs/promises";
import path from "node:path";
import { GREETER_MUSIC_TYPES, greeterMusic, greeterMusicDir } from "@/lib/greeter-music";

export const runtime = "nodejs";

// One music file for the greeter TV. Only names from a current playlist are served.
export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name") || "";
  const folder = name.split("/")[0];
  if (!(await greeterMusic(folder)).includes(name)) return new Response("Not found", { status: 404 });
  const data = await readFile(path.join(greeterMusicDir(), name));
  return new Response(new Uint8Array(data), {
    headers: { "content-type": GREETER_MUSIC_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream", "cache-control": "max-age=86400" },
  });
}
