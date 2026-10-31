import { readdir } from "node:fs/promises";
import path from "node:path";
import { getLocalStoragePath } from "@/lib/config";

/**
 * Background music for the greeter TV: audio files in <uploads>/greeter-music/<season>/
 * (halloween, thanksgiving, christmas) and greeter-music/everyday/ for the rest of the year.
 * A season with no files of its own plays the everyday music. Only use music licensed for
 * playing in a business.
 */
export const GREETER_MUSIC_TYPES: Record<string, string> = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav" };

export function greeterMusicDir(): string {
  return path.join(getLocalStoragePath(), "greeter-music");
}

async function filesIn(folder: string): Promise<string[]> {
  try {
    return (await readdir(path.join(greeterMusicDir(), folder), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && GREETER_MUSIC_TYPES[path.extname(entry.name).toLowerCase()])
      .map((entry) => `${folder}/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

/** Track names ("halloween/song.mp3") for a season, falling back to the everyday music. */
export async function greeterMusic(season: string): Promise<string[]> {
  const seasonal = /^[a-z]+$/.test(season) && season !== "everyday" ? await filesIn(season) : [];
  return seasonal.length ? seasonal : filesIn("everyday");
}
