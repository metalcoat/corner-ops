// Makes the launcher icons from the store logo: node tools/team-app/icons.mjs (run from the repo root).
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(sizes)) {
  const dir = `tools/team-app/app/src/main/res/mipmap-${density}`;
  mkdirSync(dir, { recursive: true });
  await sharp("public/corner-deli-logo.png").resize(size, size).png().toFile(`${dir}/ic_launcher.png`);
}
