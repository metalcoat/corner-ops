import { getSql } from "@/lib/db";

/** Greeter TV volumes, 0-100: background music and the walk-in greeting. */
export type GreeterVolumes = { music: number; greeting: number };
const DEFAULTS: GreeterVolumes = { music: 13, greeting: 100 };

export async function greeterVolumes(business = "Corner Deli"): Promise<GreeterVolumes> {
  const row = (await getSql()`SELECT music_volume, greeting_volume FROM greeter_tv_settings WHERE business = ${business}`)[0];
  return row ? { music: Number(row.music_volume), greeting: Number(row.greeting_volume) } : DEFAULTS;
}

export async function saveGreeterVolumes(volumes: GreeterVolumes, updatedBy: string, business = "Corner Deli"): Promise<GreeterVolumes> {
  const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const music = clamp(volumes.music), greeting = clamp(volumes.greeting);
  await getSql()`
    INSERT INTO greeter_tv_settings (business, music_volume, greeting_volume, updated_by, updated_at)
    VALUES (${business}, ${music}, ${greeting}, ${updatedBy}, NOW())
    ON CONFLICT (business) DO UPDATE SET music_volume = EXCLUDED.music_volume,
      greeting_volume = EXCLUDED.greeting_volume, updated_by = EXCLUDED.updated_by, updated_at = NOW()`;
  return { music, greeting };
}
