// Draws JUMBO RUSH onto a canvas. Kept apart from the engine so the engine stays DOM-free.
import { MAX_STRIKES, SHIFT_SECONDS, type Flyer, type PizzaRush, type Topping } from "./engine";

const sprites = new Map<string, HTMLCanvasElement>();

/** A pizza drawn once per topping and size, then reused every frame. */
function pizzaSprite(topping: Topping, r: number, jumbo: boolean) {
  const key = `${topping}:${Math.round(r)}:${jumbo}`;
  const cached = sprites.get(key);
  if (cached) return cached;
  const size = Math.ceil(r * 2 + 4);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  let seed = r * 97 + topping.length * 13;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  ctx.fillStyle = jumbo ? "#e0a050" : "#d99a52";
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#b9763a";
  ctx.beginPath();
  ctx.arc(c, c, r * 0.92, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c63b26";
  ctx.beginPath();
  ctx.arc(c, c, r * 0.84, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f7d56a";
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * r * 0.5;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * d, c + Math.sin(a) * d, r * (0.28 + rnd() * 0.18), 0, Math.PI * 2);
    ctx.fill();
  }
  const dot = (color: string, rad: number, n: number, ring = false) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const d = Math.sqrt(rnd()) * r * 0.66;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(c + Math.cos(a) * d, c + Math.sin(a) * d, rad, 0, Math.PI * 2);
      ctx.fill();
      if (ring) {
        ctx.fillStyle = "#f7d56a";
        ctx.beginPath();
        ctx.arc(c + Math.cos(a) * d, c + Math.sin(a) * d, rad * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };
  if (topping === "pepperoni" || topping === "supreme") dot("#9e2f27", r * 0.13, jumbo ? 14 : 8);
  if (topping === "mushroom" || topping === "supreme") dot("#e4d6b8", r * 0.09, 7);
  if (topping === "peppers" || topping === "supreme") dot("#3f8f3a", r * 0.07, 9);
  if (topping === "olives" || topping === "supreme") dot("#222", r * 0.07, 8, true);
  // Slice lines.
  ctx.strokeStyle = "#00000022";
  ctx.lineWidth = Math.max(1, r * 0.03);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(c - Math.cos(a) * r * 0.86, c - Math.sin(a) * r * 0.86);
    ctx.lineTo(c + Math.cos(a) * r * 0.86, c + Math.sin(a) * r * 0.86);
    ctx.stroke();
  }
  sprites.set(key, canvas);
  return canvas;
}

function drawHazard(ctx: CanvasRenderingContext2D, f: Flyer, t: number) {
  const r = f.r;
  ctx.save();
  ctx.translate(f.x, f.y);
  // Red warning glow.
  ctx.fillStyle = `rgba(255,60,40,${0.18 + 0.12 * Math.sin(t * 12)})`;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(f.angle * 0.3);
  if (f.kind === "phone") {
    const shake = Math.sin(t * 50) * r * 0.06;
    ctx.translate(shake, 0);
    ctx.fillStyle = "#1c1c1c";
    roundRect(ctx, -r * 0.45, -r * 0.8, r * 0.9, r * 1.6, r * 0.15);
    ctx.fill();
    ctx.fillStyle = "#7cd3ff";
    ctx.fillRect(-r * 0.36, -r * 0.62, r * 0.72, r * 1.05);
    ctx.fillStyle = "#ff5040";
    ctx.font = `900 ${r * 0.32}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("RING", 0, -r * 0.08);
    ctx.fillText("RING", 0, r * 0.28);
  } else if (f.kind === "review") {
    ctx.fillStyle = "#fff";
    roundRect(ctx, -r * 0.8, -r * 0.55, r * 1.6, r * 1.1, r * 0.1);
    ctx.fill();
    ctx.fillStyle = "#ffb800";
    star(ctx, -r * 0.45, -r * 0.12, r * 0.24);
    ctx.fillStyle = "#ccc";
    for (let i = 1; i < 5; i++) star(ctx, -r * 0.45 + i * r * 0.24, -r * 0.12, r * 0.1);
    ctx.fillStyle = "#333";
    ctx.fillRect(-r * 0.6, r * 0.2, r * 1.2, r * 0.07);
    ctx.fillRect(-r * 0.6, r * 0.34, r * 0.8, r * 0.07);
  } else {
    ctx.fillStyle = "#ffe066";
    ctx.fillRect(-r * 0.85, -r * 0.45, r * 1.7, r * 0.9);
    ctx.strokeStyle = "#333";
    ctx.setLineDash([r * 0.12, r * 0.08]);
    ctx.lineWidth = Math.max(1, r * 0.05);
    ctx.strokeRect(-r * 0.78, -r * 0.38, r * 1.56, r * 0.76);
    ctx.setLineDash([]);
    ctx.fillStyle = "#333";
    ctx.font = `900 ${r * 0.3}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("$1 OFF", 0, -r * 0.02);
    ctx.font = `700 ${r * 0.2}px system-ui, sans-serif`;
    ctx.fillText("EXP 2009", 0, r * 0.26);
  }
  ctx.restore();
}

function drawEspresso(ctx: CanvasRenderingContext2D, f: Flyer) {
  const r = f.r;
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(f.angle * 0.2);
  ctx.fillStyle = "#fff";
  ctx.fillRect(-r * 0.5, -r * 0.45, r * 1.0, r * 0.9);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = r * 0.12;
  ctx.beginPath();
  ctx.arc(r * 0.6, 0, r * 0.22, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  ctx.fillStyle = "#5a3418";
  ctx.fillRect(-r * 0.42, -r * 0.4, r * 0.84, r * 0.2);
  ctx.fillStyle = "#c9a27a";
  ctx.font = `900 ${r * 0.28}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("☕", 0, r * 0.25);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const d = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  ctx.closePath();
  ctx.fill();
}

let backdrop: { key: string; canvas: HTMLCanvasElement } | null = null;
function drawBackdrop(ctx: CanvasRenderingContext2D, W: number, H: number, dpr: number) {
  const key = `${W}x${H}@${dpr}`;
  if (!backdrop || backdrop.key !== key) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(W * dpr);
    canvas.height = Math.ceil(H * dpr);
    const b = canvas.getContext("2d")!;
    b.scale(dpr, dpr);
    // Tiled backsplash.
    b.fillStyle = "#1d1a24";
    b.fillRect(0, 0, W, H);
    const tile = Math.max(28, Math.min(W, H) / 12);
    for (let y = 0; y < H; y += tile)
      for (let x = 0; x < W; x += tile) {
        b.fillStyle = ((x / tile + y / tile) | 0) % 2 ? "#24212c" : "#2a2633";
        b.fillRect(x + 1, y + 1, tile - 2, tile - 2);
      }
    // Oven mouth glowing at the bottom.
    const glow = b.createRadialGradient(W / 2, H + 40, 10, W / 2, H + 40, Math.max(W, H) * 0.55);
    glow.addColorStop(0, "rgba(255,140,40,0.55)");
    glow.addColorStop(1, "rgba(255,140,40,0)");
    b.fillStyle = glow;
    b.fillRect(0, 0, W, H);
    b.fillStyle = "#121016";
    b.fillRect(0, H - 26, W, 26);
    b.fillStyle = "#3a2b20";
    b.fillRect(0, H - 30, W, 4);
    // Neon sign.
    b.font = `900 ${Math.min(W, H) * 0.075}px system-ui, sans-serif`;
    b.textAlign = "center";
    b.fillStyle = "rgba(255,80,90,0.16)";
    b.fillText("CORNER DELI", W / 2, H * 0.52);
    backdrop = { key, canvas };
  }
  ctx.drawImage(backdrop.canvas, 0, 0, W, H);
}

export type Trail = Array<{ x: number; y: number; t: number }>;

export function renderRush(ctx: CanvasRenderingContext2D, g: PizzaRush, trail: Trail, now: number, dpr: number) {
  const { W, H } = g;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.save();
  if (g.shake > 0) ctx.translate((Math.random() - 0.5) * 12 * g.shake, (Math.random() - 0.5) * 12 * g.shake);
  drawBackdrop(ctx, W, H, dpr);
  if (g.slowMo > 0) {
    ctx.fillStyle = "rgba(90,52,24,0.22)";
    ctx.fillRect(0, 0, W, H);
  }

  for (const s of g.splats) {
    ctx.globalAlpha = Math.min(1, s.life * 2);
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  for (const h of g.halves) {
    const sprite = pizzaSprite(h.topping, h.r, h.jumbo);
    ctx.save();
    ctx.globalAlpha = Math.min(1, h.life * 1.5);
    ctx.translate(h.x, h.y);
    ctx.rotate(h.cut);
    ctx.beginPath();
    ctx.rect(-h.r - 2, h.side > 0 ? 0 : -h.r - 2, h.r * 2 + 4, h.r + 2);
    ctx.clip();
    ctx.rotate(h.angle - h.cut);
    ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
    ctx.restore();
  }

  for (const f of g.flyers) {
    if (f.kind === "pizza" || f.kind === "jumbo") {
      const sprite = pizzaSprite(f.topping, f.r, f.kind === "jumbo");
      ctx.save();
      ctx.translate(f.x, f.y);
      if (f.kind === "jumbo") {
        ctx.fillStyle = `rgba(255,209,102,${0.25 + 0.15 * Math.sin(now / 90)})`;
        ctx.beginPath();
        ctx.arc(0, 0, f.r * 1.18, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.rotate(f.angle);
      ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
      ctx.restore();
      if (f.kind === "jumbo") label(ctx, `JUMBO ×${f.hp}`, f.x, f.y - f.r - 8, 13, "#ffd166");
    } else if (f.kind === "espresso") drawEspresso(ctx, f);
    else drawHazard(ctx, f, now / 1000);
  }

  // Swipe trail.
  const live = trail.filter((p) => now - p.t < 140);
  if (live.length > 1) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const [width, color] of [[10, "rgba(124,211,255,0.35)"], [4, "#ffffff"]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      live.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
  }

  for (const f of g.floaters) {
    ctx.globalAlpha = Math.min(1, (1.6 - f.t) * 2);
    label(ctx, f.text, f.x, f.y, f.size, f.color);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  if (g.flash > 0) {
    ctx.fillStyle = `rgba(255,40,30,${g.flash})`;
    ctx.fillRect(0, 0, W, H);
  }
  drawHud(ctx, g);
  if (g.banner > 0 && g.state === "play") {
    const a = Math.min(1, g.banner * 1.5);
    ctx.globalAlpha = a;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, H * 0.36, W, 86);
    label(ctx, g.phase.name, W / 2, H * 0.36 + 34, Math.min(34, W / 11), "#ffd166");
    label(ctx, g.phase.line, W / 2, H * 0.36 + 66, Math.min(15, W / 26), "#fff");
    ctx.globalAlpha = 1;
  }
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string) {
  ctx.font = `900 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(3, size / 4);
  ctx.strokeStyle = "#000";
  ctx.lineJoin = "round";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawHud(ctx: CanvasRenderingContext2D, g: PizzaRush) {
  const { W } = g;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, W, 58);
  // Shift clock: 5:00 PM to 7:52 PM.
  const share = g.time / SHIFT_SECONDS;
  const minutes = 17 * 60 + Math.floor(share * 172);
  const clock = `${((Math.floor(minutes / 60) + 11) % 12) + 1}:${String(minutes % 60).padStart(2, "0")} PM`;
  ctx.fillStyle = "#333";
  ctx.fillRect(10, 46, W - 20, 6);
  ctx.fillStyle = share > 0.86 ? "#ff6b5b" : "#ffd166";
  ctx.fillRect(10, 46, (W - 20) * share, 6);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = "#fff";
  ctx.font = `900 22px system-ui, sans-serif`;
  ctx.fillText(g.score.toLocaleString(), 12, 22);
  ctx.font = `700 11px system-ui, sans-serif`;
  ctx.fillStyle = "#aaa";
  ctx.fillText(`${g.delivered} PIZZAS · ${clock}${g.multiplier > 1 ? ` · ×${g.multiplier}` : ""}`, 12, 38);
  // Strikes: three pizza boxes, crossed out as they're used.
  for (let i = 0; i < MAX_STRIKES; i++) {
    const x = W - 30 - i * 30;
    ctx.fillStyle = i < g.strikes ? "#5a1d18" : "#d8b98a";
    ctx.fillRect(x, 12, 24, 22);
    ctx.strokeStyle = "#7a5a34";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, 12, 24, 22);
    if (i < g.strikes) {
      ctx.strokeStyle = "#ff5040";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x + 4, 16);
      ctx.lineTo(x + 20, 30);
      ctx.moveTo(x + 20, 16);
      ctx.lineTo(x + 4, 30);
      ctx.stroke();
    }
  }
}
