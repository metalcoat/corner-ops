import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

const root = process.cwd();
const appDir = path.join(root, "src", "app");
const palettePath = path.join(appDir, "color-tokens.css");
const hex = /#[0-9a-fA-F]{3,8}\b/g;

function cssFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.isFile() && entry.name.endsWith(".css") && full !== palettePath ? [full] : [];
  });
}

function canonical(value) {
  let raw = value.slice(1).toLowerCase();
  if (raw.length === 3 || raw.length === 4) raw = raw.split("").map((c) => c + c).join("");
  return `#${raw}`;
}

const colors = new Set();
const files = cssFiles(appDir);
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const parsed = postcss.parse(source, { from: file });
  parsed.walkDecls((decl) => {
    decl.value = decl.value.replace(hex, (match) => {
      const value = canonical(match);
      colors.add(value);
      return `var(--color-${value.slice(1)})`;
    });
  });
  fs.writeFileSync(file, parsed.toString());
}

const sorted = [...colors].sort();
const palette = [
  "/* Central literal palette. Feature styles consume these through semantic or palette tokens. */",
  ":root {",
  ...sorted.map((value) => `  --color-${value.slice(1)}: ${value};`),
  "}",
  "",
].join("\n");
fs.writeFileSync(palettePath, palette);

const layoutPath = path.join(appDir, "layout.tsx");
let layout = fs.readFileSync(layoutPath, "utf8");
if (!layout.includes('import "./color-tokens.css";')) {
  const anchor = 'import "./globals.css";';
  if (!layout.includes(anchor)) throw new Error("Root globals.css import not found");
  layout = layout.replace(anchor, 'import "./color-tokens.css";\n' + anchor);
  fs.writeFileSync(layoutPath, layout);
}

console.log(`Centralized ${sorted.length} unique CSS colors across ${files.length} feature stylesheets.`);
