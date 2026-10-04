// Top-down (3/4 from above) vehicles, riders and street props for the
// Delivery Boy street. Everything shares one camera: looking down at the road
// from above and slightly behind, so we see roofs and the south-facing sides.

type G = CanvasRenderingContext2D;
const R = (g: G, x: number, y: number, w: number, h: number, c: string) => {
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
};
function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
function rounded(g: G, x: number, y: number, w: number, h: number, r: number, c: string) {
  g.fillStyle = c;
  g.beginPath();
  g.roundRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h), r);
  g.fill();
}

export const CAR_SCALE = 0.88;
export const PAINTS = ["#2a5ea8", "#8a2a2a", "#d8d4c8", "#2f2f34", "#6a7a3a", "#b08a3a", "#5a5f66", "#c8c2b0", "#7a2f5a"];

export type CarOptions = {
  paint: string;
  /** Radians; 0 points up the screen (driving away from us), π toward us. */
  angle: number;
  kind?: "car" | "suv" | "van" | "pickup" | "delivery";
  headlights?: boolean;
  brake?: boolean;
  tarp?: boolean;
  /** Front wheels turned (radians), for the player's car when steering. */
  steer?: number;
  roofLoad?: "mattress" | "tree" | "kayak" | null;
  rusty?: boolean;
  time?: number;
};

/** Car dimensions in screen pixels (width across, length along). */
export function carSize(kind: CarOptions["kind"] = "car") {
  return kind === "van" ? { w: 44, l: 84 } : kind === "pickup" ? { w: 42, l: 80 } : kind === "suv" || kind === "delivery" ? { w: 42, l: 76 } : { w: 40, l: 72 };
}

/** Draws a vehicle seen from above, centred on (cx, cy). */
export function drawCarTop(g: G, cx: number, cy: number, o: CarOptions) {
  const { w, l } = carSize(o.kind);
  g.save();
  g.translate(Math.round(cx), Math.round(cy));
  g.rotate(o.angle);
  // Cars are drawn a little under full scale so the street feels roomy.
  g.scale(CAR_SCALE, CAR_SCALE);
  // Shadow, offset down-right in screen space.
  g.save();
  g.rotate(-o.angle);
  g.fillStyle = "rgba(0,0,0,0.32)";
  g.beginPath();
  g.ellipse(4, 6, w / 2 + 3, l / 2 + 2, o.angle, 0, Math.PI * 2);
  g.fill();
  g.restore();
  const x = -w / 2,
    y = -l / 2,
    paint = o.tarp ? "#2f6fc4" : o.paint;
  // Wheels (front ones turn with steering).
  for (const [wx, wy, turn] of [
    [x - 3, y + l * 0.16, true],
    [x + w - 5, y + l * 0.16, true],
    [x - 3, y + l * 0.7, false],
    [x + w - 5, y + l * 0.7, false],
  ] as const) {
    g.save();
    g.translate(wx + 4, wy + 8);
    if (turn && o.steer) g.rotate(o.steer);
    R(g, -4, -8, 8, 16, "#141418");
    R(g, -3, -6, 2, 12, "#3a3a40");
    g.restore();
  }
  rounded(g, x, y, w, l, 9, shade(paint, 0.7));
  rounded(g, x + 2, y + 2, w - 4, l - 4, 8, paint);
  if (!o.tarp) {
    // Hood, windshield, roof, rear window, trunk.
    const hood = l * (o.kind === "van" ? 0.1 : 0.2),
      cab = o.kind === "pickup" ? 0.42 : o.kind === "van" ? 0.86 : 0.58;
    R(g, x + 6, y + 4, w - 12, hood - 4, shade(paint, 1.12));
    R(g, x + 5, y + hood, w - 10, 10, "#34506e");
    R(g, x + 9, y + hood + 2, 8, 3, "#8fb0cf");
    R(g, x + 6, y + hood + 10, w - 12, l * cab - 16, shade(paint, 0.92));
    R(g, x + 6, y + hood + 10, 3, l * cab - 16, shade(paint, 1.15));
    if (o.kind === "pickup") {
      R(g, x + 5, y + hood + l * cab - 6, w - 10, 6, "#34506e");
      R(g, x + 6, y + hood + l * cab + 2, w - 12, l * (1 - cab) - hood - 6, "#2a2a2e");
      R(g, x + 8, y + hood + l * cab + 6, w - 16, 10, "#8a5a32");
    } else if (o.kind !== "van") {
      R(g, x + 6, y + hood + l * cab - 6, w - 12, 7, "#34506e");
      R(g, x + 6, y + l - 12, w - 12, 8, shade(paint, 1.08));
    }
    // Mirrors.
    R(g, x - 4, y + hood + 4, 4, 4, shade(paint, 0.8));
    R(g, x + w, y + hood + 4, 4, 4, shade(paint, 0.8));
    if (o.rusty) {
      R(g, x + 8, y + l * 0.5, 9, 6, "#8a4a2a");
      R(g, x + w - 16, y + 8, 7, 5, "#8a4a2a");
      R(g, x + 12, y + l - 16, 10, 4, "#a05a32");
    }
    if (o.kind === "delivery") {
      // The Corner Deli Equinox: a giant sub on the roof rack.
      R(g, x + 8, y + hood + 14, w - 16, 3, "#1c1c20");
      R(g, x + 8, y + hood + l * cab - 18, w - 16, 3, "#1c1c20");
      rounded(g, x + 10, y + hood + 18, w - 20, l * cab - 40, 6, "#d8b078");
      R(g, x + 12, y + hood + 24, w - 24, 4, "#5cac3c");
      R(g, x + 12, y + hood + 30, w - 24, 4, "#d8302c");
      R(g, x + 12, y + hood + 36, w - 24, 3, "#f8d848");
      R(g, x + 13, y + hood + 20, 4, l * cab - 46, "#f0cc94");
      R(g, x + 2, y + l * 0.5, 3, 14, "#d8302c");
      R(g, x + w - 5, y + l * 0.5, 3, 14, "#d8302c");
    }
    if (o.roofLoad === "mattress") {
      R(g, x + 4, y + hood + 12, w - 8, l * 0.44, "#e8e0d0");
      for (let i = 0; i < 4; i++) R(g, x + 4, y + hood + 18 + i * 8, w - 8, 1, "#c8c0b0");
      R(g, x + 2, y + hood + 20, w - 4, 2, "#d8302c");
    } else if (o.roofLoad === "tree") {
      for (let i = 0; i < 6; i++) R(g, x + 6 + (i % 2) * 4, y + hood + 8 + i * 6, w - 12 - (i % 2) * 8, 6, i % 2 ? "#2e6e2a" : "#3a8a34");
    } else if (o.roofLoad === "kayak") {
      rounded(g, x + w / 2 - 6, y - 4, 12, l + 8, 6, "#f08830");
    }
  } else {
    // A blue tarp, bungee-corded over whatever this used to be.
    for (let yy = y + 6; yy < y + l - 4; yy += 6) R(g, x + 3, yy, w - 6, 1, "#2558a0");
    R(g, x + 3, y + l * 0.3, w - 6, 2, "#e0302c");
    R(g, x + 3, y + l * 0.7, w - 6, 2, "#e0302c");
    R(g, x + w / 2 - 1, y + 4, 2, l - 8, "#e0302c");
    const flap = Math.sin((o.time ?? 0) / 180) > 0 ? 4 : 1;
    R(g, x + w - 6, y + l - 10, 6 + flap, 8, "#4a88d8");
  }
  // Lights: headlights at the front (top), tail lights at the back.
  R(g, x + 5, y + 1, 9, 3, o.headlights ? "#fff6c0" : "#e8e4c8");
  R(g, x + w - 14, y + 1, 9, 3, o.headlights ? "#fff6c0" : "#e8e4c8");
  R(g, x + 5, y + l - 4, 9, 3, o.brake ? "#ff3020" : "#a01818");
  R(g, x + w - 14, y + l - 4, 9, 3, o.brake ? "#ff3020" : "#a01818");
  g.restore();
}

/** Headlight beams for a vehicle (draw with "lighter" compositing at night). */
export function headlightBeams(g: G, cx: number, cy: number, angle: number, length: number, kind: CarOptions["kind"] = "car") {
  const l = carSize(kind).l * CAR_SCALE;
  g.save();
  g.translate(cx, cy);
  g.rotate(angle);
  const grad = g.createLinearGradient(0, -l / 2, 0, -l / 2 - length);
  grad.addColorStop(0, "rgba(255,240,170,0.34)");
  grad.addColorStop(1, "rgba(255,240,170,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(-18, -l / 2);
  g.lineTo(18, -l / 2);
  g.lineTo(46, -l / 2 - length);
  g.lineTo(-46, -l / 2 - length);
  g.fill();
  g.restore();
}

/** A kid on an e-bike from above, pedalling, hood up, no helmet. */
export function drawEbikeTop(g: G, cx: number, cy: number, angle: number, variant: number, time: number) {
  const hoodie = ["#c7312c", "#2a5ea8", "#3a7a32", "#5a2a7a", "#222", "#e0a020"][variant % 6];
  const pedal = Math.sin(time / 70);
  g.save();
  g.translate(Math.round(cx), Math.round(cy));
  g.rotate(angle);
  g.fillStyle = "rgba(0,0,0,0.3)";
  g.fillRect(-4, -20, 12, 44);
  R(g, -2, -24, 4, 14, "#141418");
  R(g, -2, 10, 4, 14, "#141418");
  R(g, -1, -10, 2, 20, "#8a8f96");
  R(g, -11, -14, 22, 3, "#9a9aa0");
  // Legs pumping.
  R(g, -7, 2 + pedal * 3, 4, 9, "#2a3a5a");
  R(g, 3, 2 - pedal * 3, 4, 9, "#2a3a5a");
  rounded(g, -8, -9, 16, 16, 5, hoodie);
  rounded(g, -6, -14, 12, 10, 5, shade(hoodie, 0.8));
  R(g, -13, -14, 4, 4, "#e8b890");
  R(g, 9, -14, 4, 4, "#e8b890");
  // Headlight flicker and a phone light, because of course.
  if (Math.floor(time / 140) % 2) R(g, -2, -27, 4, 3, "#c8f8ff");
  g.restore();
}

/** Ride-on mower (with a guy) from above; blades spin. */
export function drawMowerTop(g: G, cx: number, cy: number, time: number) {
  g.save();
  g.translate(Math.round(cx), Math.round(cy));
  R(g, -18, -20, 36, 44, "rgba(0,0,0,0.3)");
  rounded(g, -16, -22, 32, 42, 6, "#c7312c");
  rounded(g, -12, -18, 24, 12, 3, "#e05a4a");
  R(g, -20, -16, 6, 12, "#141418");
  R(g, 14, -16, 6, 12, "#141418");
  R(g, -21, 8, 7, 14, "#141418");
  R(g, 14, 8, 7, 14, "#141418");
  rounded(g, -8, -2, 16, 18, 5, "#3a5a8a");
  rounded(g, -6, -8, 12, 10, 5, "#e8b890");
  R(g, -7, -9, 14, 4, "#2a6a2a");
  const a = (time / 40) % Math.PI;
  g.strokeStyle = "rgba(220,220,220,0.6)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(Math.cos(a) * 14, 18 + Math.sin(a) * 4);
  g.lineTo(-Math.cos(a) * 14, 18 - Math.sin(a) * 4);
  g.stroke();
  for (let i = 0; i < 4; i++) R(g, -14 + ((time / 20 + i * 9) % 28), 24 + (i % 2) * 3, 2, 2, "#7aba4a");
  g.restore();
}

export function drawPotholeTop(g: G, cx: number, cy: number, size: number) {
  const w = Math.round(30 * size),
    h = Math.round(18 * size);
  g.fillStyle = "#2e3136";
  g.beginPath();
  g.ellipse(cx, cy, w / 2 + 2, h / 2 + 2, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#141519";
  g.beginPath();
  g.ellipse(cx, cy - 1, w / 2, h / 2, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#6a6e74";
  g.fillRect(Math.round(cx - w / 3), Math.round(cy + h / 2), Math.round((w * 2) / 3), 1);
  if (size > 1.1) {
    g.fillStyle = "#3a5070";
    g.beginPath();
    g.ellipse(cx + 2, cy + 1, w / 4, h / 5, 0, 0, Math.PI * 2);
    g.fill();
  }
}

/** Utility pole from above: a dot with a cross-arm and a street light. */
export function drawPoleTop(g: G, x: number, y: number, side: "left" | "right", night: boolean) {
  const dir = side === "left" ? 1 : -1;
  R(g, x - 3, y - 3, 7, 7, "#5a3a22");
  R(g, x - 10, y - 1, 20, 3, "#4a3220");
  R(g, x, y + 2, dir * 30, 2, "#4a4e54");
  R(g, x + dir * 30 - 4, y, 8, 6, night ? "#fff2b0" : "#8a8f96");
}

export function drawTrashTop(g: G, x: number, y: number) {
  for (const [dx, lid] of [[-8, true], [8, false]] as const) {
    g.fillStyle = "rgba(0,0,0,0.3)";
    g.beginPath();
    g.ellipse(x + dx + 3, y + 4, 9, 9, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = lid ? "#3a4048" : "#1c1c20";
    g.beginPath();
    g.ellipse(x + dx, y, 8, 8, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = lid ? "#5a6068" : "#2a2a30";
    g.beginPath();
    g.ellipse(x + dx, y, 6, 6, 0, 0, Math.PI * 2);
    g.fill();
    if (lid) R(g, x + dx - 3, y - 1, 6, 2, "#7a8088");
  }
  R(g, x - 4, y + 8, 8, 6, "#1c1c20");
}

export function drawCartTop(g: G, x: number, y: number) {
  R(g, x - 10, y - 14, 22, 30, "rgba(0,0,0,0.25)");
  R(g, x - 12, y - 16, 22, 28, "#b8bcc4");
  R(g, x - 10, y - 14, 18, 24, "#5a5f66");
  for (let xx = x - 10; xx < x + 8; xx += 4) R(g, xx, y - 14, 1, 24, "#9aa0a8");
  for (let yy = y - 14; yy < y + 10; yy += 4) R(g, x - 10, yy, 18, 1, "#9aa0a8");
  R(g, x - 13, y + 12, 24, 3, "#c7312c");
}

export function drawDumpsterTop(g: G, x: number, y: number) {
  R(g, x - 16, y - 18, 36, 40, "rgba(0,0,0,0.3)");
  R(g, x - 18, y - 20, 36, 38, "#2f5a3a");
  R(g, x - 17, y - 19, 16, 36, "#3a6a46");
  R(g, x + 1, y - 19, 16, 36, "#33603f");
  R(g, x - 1, y - 20, 2, 38, "#1f3a26");
  R(g, x - 18, y + 14, 36, 4, "#244a2e");
  R(g, x + 4, y - 14, 10, 6, "#e8e4d8");
}

export function drawTentTop(g: G, x: number, y: number) {
  g.fillStyle = "rgba(0,0,0,0.3)";
  g.beginPath();
  g.ellipse(x + 4, y + 4, 22, 18, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#e07a28";
  g.beginPath();
  g.ellipse(x, y, 22, 18, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "#8a4a18";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x - 20, y - 8);
  g.lineTo(x + 20, y + 8);
  g.moveTo(x - 20, y + 8);
  g.lineTo(x + 20, y - 8);
  g.stroke();
  R(g, x - 4, y + 12, 8, 6, "#3a2a1a");
  R(g, x + 16, y + 10, 10, 6, "#5a7a9a");
}

/** Pickups: a glowing turbo pickle, a frozen sub, a bag of subs. */
export function drawPickup(g: G, type: "boost" | "slow" | "restock", x: number, y: number, time: number) {
  const bob = Math.round(Math.sin(time / 160) * 2),
    glint = Math.floor(time / 120) % 6 === 0;
  g.fillStyle = "rgba(0,0,0,0.3)";
  g.beginPath();
  g.ellipse(x + 2, y + 12, 12, 5, 0, 0, Math.PI * 2);
  g.fill();
  if (type === "boost") {
    rounded(g, x - 7, y - 16 + bob, 14, 28, 7, "#4c9a30");
    for (let i = 0; i < 6; i++) R(g, x - 5 + (i % 2) * 7, y - 12 + i * 4 + bob, 3, 2, "#9cdc64");
  } else if (type === "slow") {
    rounded(g, x - 16, y - 7 + bob, 32, 14, 6, "#b8e0f0");
    R(g, x - 14, y - 2 + bob, 28, 3, "#5cac3c");
    R(g, x - 14, y + 1 + bob, 28, 2, "#d8302c");
    for (let i = 0; i < 4; i++) R(g, x - 12 + i * 8, y - 6 + bob, 2, 2, "#ffffff");
  } else {
    R(g, x - 11, y - 14 + bob, 22, 26, "#c79a5b");
    R(g, x - 11, y - 14 + bob, 22, 4, "#a77a3d");
    R(g, x - 8, y - 6 + bob, 16, 9, "#d8302c");
    R(g, x - 5, y - 4 + bob, 10, 2, "#ffffff");
  }
  if (glint) R(g, x + 6, y - 14 + bob, 3, 3, "#ffffff");
}

/**
 * Animates a single painted side-view sprite: the body bobs while the legs
 * (the bottom of the sprite) scissor back and forth, and waddlers rock.
 */
export function drawAnimated(
  g: G,
  image: HTMLCanvasElement,
  cx: number,
  bottom: number,
  o: { flip?: boolean; time: number; gait: "trot" | "walk" | "waddle" | "hop" | "graze"; moving: boolean },
) {
  const w = image.width,
    h = image.height,
    speed = o.gait === "trot" ? 85 : o.gait === "hop" ? 120 : o.gait === "waddle" ? 140 : o.gait === "graze" ? 600 : 160,
    phase = o.moving ? o.time / speed : o.time / 900,
    step = Math.sin(phase * Math.PI),
    legs = Math.round(h * (o.gait === "waddle" ? 0.22 : 0.36));
  let lift = o.moving ? Math.abs(step) * (o.gait === "hop" ? 10 : 2) : 0;
  if (o.gait === "graze") lift = 0;
  g.save();
  g.fillStyle = "rgba(0,0,0,0.28)";
  g.beginPath();
  g.ellipse(cx + 3, bottom - 1, w * 0.36, Math.max(3, h * 0.08), 0, 0, Math.PI * 2);
  g.fill();
  g.translate(Math.round(cx), Math.round(bottom - lift));
  if (o.flip) g.scale(-1, 1);
  if (o.gait === "waddle" && o.moving) g.rotate(step * 0.09);
  // Body.
  g.drawImage(image, 0, 0, w, h - legs, -w / 2, -h, w, h - legs);
  // Legs, scissoring.
  g.save();
  g.translate(0, -legs);
  if (o.moving) g.transform(1, 0, step * (o.gait === "walk" ? 0.32 : 0.45), 1, 0, 0);
  g.drawImage(image, 0, h - legs, w, legs, -w / 2, 0, w, legs);
  g.restore();
  g.restore();
}
