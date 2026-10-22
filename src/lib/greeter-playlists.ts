/**
 * YouTube playlists for the greeter TV's background music, by menu board season. A season
 * without a playlist plays the everyday one; with no playlists at all the greeter falls back
 * to music files in the uploads volume (see greeter-music.ts). Paste the part after "list="
 * from the playlist's share link.
 */
export const GREETER_PLAYLISTS: Record<string, string> = {
  everyday: "",
  halloween: "",
  thanksgiving: "",
  christmas: "",
};

export function greeterPlaylist(season: string): string | null {
  return GREETER_PLAYLISTS[season] || GREETER_PLAYLISTS.everyday || null;
}
