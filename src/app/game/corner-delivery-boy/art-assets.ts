// Loads the painted sprite atlases once and pre-scales each sprite to the
// size it is drawn at, so frames only blit canvases (Donkey Kong Country style
// pre-rendered art on a pixel canvas).

type Crop = [number, number, number, number];
const ROADSIDE: Record<string, Crop> = {
  storefront: [298, 58, 196, 190],
  mailbox: [589, 90, 133, 166],
  pole: [797, 9, 198, 239],
  dumpster: [28, 337, 228, 144],
  junkcar: [256, 350, 250, 130],
  tent: [532, 256, 236, 233],
  tree: [768, 260, 234, 243],
};
const WILDLIFE: Record<string, Crop> = {
  squirrel: [12, 70, 151, 145],
  cat: [196, 64, 188, 192],
  dog: [384, 57, 174, 161],
  raccoon: [584, 95, 177, 123],
  goose: [11, 284, 170, 180],
  deer: [198, 256, 182, 208],
  cow: [384, 298, 192, 166],
  person: [576, 272, 166, 195],
};
/**
 * Drawn height in screen pixels at 512×448. Sized against the Equinox (about
 * 1.7 m tall = 56 px, so roughly 33 px per metre), nudged up slightly for the
 * smallest animals so they stay readable.
 */
const HEIGHTS: Record<string, number> = {
  storefront: 112,
  mailbox: 40,
  pole: 150,
  dumpster: 40,
  junkcar: 44,
  tent: 46,
  tree: 96,
  treeSmall: 64,
  squirrel: 14,
  cat: 18,
  dog: 24,
  raccoon: 17,
  goose: 28,
  deer: 54,
  cow: 50,
  person: 56,
  suv: 56,
};

export type Assets = Record<string, HTMLCanvasElement>;

function load(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${src}`));
    image.src = src;
  });
}

function scaled(image: CanvasImageSource, crop: Crop, height: number) {
  const [x, y, w, h] = crop;
  const width = Math.max(1, Math.round((w / h) * height));
  // Halve repeatedly for a clean downscale, then finish at the target size.
  let source: CanvasImageSource = image,
    sx = x,
    sy = y,
    sw = w,
    sh = h;
  while (sw / 2 > width) {
    const step = document.createElement("canvas");
    step.width = Math.round(sw / 2);
    step.height = Math.round(sh / 2);
    const g = step.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(source, sx, sy, sw, sh, 0, 0, step.width, step.height);
    source = step;
    sx = 0;
    sy = 0;
    sw = step.width;
    sh = step.height;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
  return canvas;
}

let pending: Promise<Assets> | null = null;
export function loadAssets() {
  if (!pending)
    pending = (async () => {
      const [roadside, wildlife, suv] = await Promise.all([
        load("/games/delivery-boy/roadside-atlas-v2.png"),
        load("/games/delivery-boy/wildlife-atlas-v2.png"),
        load("/games/delivery-boy/delivery-suv-pixel-v2.png"),
      ]);
      const assets: Assets = {};
      for (const [name, crop] of Object.entries(ROADSIDE))
        assets[name] = scaled(roadside, crop, HEIGHTS[name]);
      assets.treeSmall = scaled(roadside, ROADSIDE.tree, HEIGHTS.treeSmall);
      for (const [name, crop] of Object.entries(WILDLIFE))
        assets[name] = scaled(wildlife, crop, HEIGHTS[name]);
      assets.suv = scaled(suv, [0, 0, suv.width, suv.height], HEIGHTS.suv);
      return assets;
    })().catch((error) => {
      pending = null;
      throw error;
    });
  return pending;
}
