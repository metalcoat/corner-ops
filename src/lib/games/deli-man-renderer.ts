import type Phaser from "phaser";
import type { DeliManArtTheme } from "./deli-man-art";

export type DeliManRoute = { x: number; top: number; width: number };

const shade = (color: number, amount: number) => {
  const r = Math.max(0, Math.min(255, (color >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((color >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (color & 255) + amount));
  return (r << 16) | (g << 8) | b;
};

export function renderDeliManStage(
  scene: Phaser.Scene,
  art: DeliManArtTheme,
  routes: DeliManRoute[],
) {
  // One camera-fixed cached painting is dramatically cheaper than four full-size
  // world images. Midground haze, terrain, props and particles still parallax.
  scene.add
    .image(0, 0, "stage-backdrop")
    .setOrigin(0)
    .setDisplaySize(1280, 720)
    .setScrollFactor(0)
    .setDepth(-30);

  const haze = scene.add
    .rectangle(0, 0, 5600, 720, art.shadow, 0.12)
    .setOrigin(0)
    .setScrollFactor(0.32)
    .setDepth(-24);
  haze.setBlendMode("MULTIPLY");

  const g = scene.add.graphics().setDepth(-2);
  // Deep shadow and substantial front face make collision rectangles read as art.
  g.fillStyle(art.shadow, 0.96).fillRect(0, 626, 5000, 94);
  g.fillStyle(art.face).fillRect(0, 610, 5000, 82);
  g.fillStyle(shade(art.face, 18)).fillRect(0, 628, 5000, 8);
  g.fillStyle(art.surface).fillRect(0, 603, 5000, 18);
  g.fillStyle(art.edge).fillRect(0, 603, 5000, 4);
  g.fillStyle(art.shadow, 0.65).fillRect(0, 621, 5000, 7);

  drawSurfaceDetails(g, art, 0, 603, 5000);
  routes.forEach((route, index) => {
    const left = route.x - 18;
    g.fillStyle(art.shadow, 0.8).fillRect(left + 7, route.top + 29, route.width, 12);
    g.fillStyle(art.face).fillRect(left, route.top, route.width, 34);
    g.fillStyle(shade(art.face, 22)).fillRect(left, route.top + 5, route.width, 7);
    g.fillStyle(art.surface).fillRect(left, route.top - 11, route.width, 16);
    g.fillStyle(art.edge).fillRect(left, route.top - 11, route.width, 4);
    g.fillStyle(art.shadow, 0.55).fillRect(left, route.top + 25, route.width, 9);
    // Bolted corner caps and underside braces keep each platform from reading as a box.
    g.fillStyle(art.edge).fillRect(left, route.top - 11, 10, 45);
    g.fillStyle(art.edge).fillRect(left + route.width - 10, route.top - 11, 10, 45);
    for (let x = left + 32; x < left + route.width - 18; x += 68) {
      g.fillStyle(shade(art.face, 35)).fillCircle(x, route.top + 20, 3);
      g.lineStyle(2, art.shadow, 0.55).lineBetween(x + 14, route.top + 14, x + 31, route.top + 27);
    }
    drawStageProp(g, art, left + route.width / 2, route.top - 12, index);
    drawLadder(g, art, route.x, route.top, 610);
  });

  drawLargeProps(g, art);
  createAtmosphere(scene, art);
  return g;
}

function drawSurfaceDetails(
  g: Phaser.GameObjects.Graphics,
  art: DeliManArtTheme,
  start: number,
  y: number,
  width: number,
) {
  for (let x = start + 38; x < start + width; x += 112) {
    const variant = Math.floor(x / 112) % 4;
    g.lineStyle(2, art.shadow, 0.45);
    g.lineBetween(x, y + 21, x + 12 + variant * 3, y + 27);
    if (variant === 0) {
      g.fillStyle(art.accent, 0.45).fillRect(x + 28, y + 8, 23, 3);
      g.fillStyle(art.accent, 0.22).fillRect(x + 31, y + 11, 15, 2);
    }
  }
}

function drawLadder(
  g: Phaser.GameObjects.Graphics,
  art: DeliManArtTheme,
  x: number,
  top: number,
  bottom: number,
) {
  const rail = shade(art.surface, 28);
  g.lineStyle(4, art.shadow, 0.8);
  g.lineBetween(x + 3, top - 1, x + 3, bottom);
  g.lineBetween(x + 51, top - 1, x + 51, bottom);
  g.lineStyle(7, rail);
  g.lineBetween(x, top - 4, x, bottom);
  g.lineBetween(x + 48, top - 4, x + 48, bottom);
  g.lineStyle(5, art.edge, 0.88);
  for (let y = top + 10; y < bottom; y += 25) g.lineBetween(x, y, x + 48, y);
  g.fillStyle(art.glow, 0.22).fillRect(x - 4, top - 8, 56, 7);
}

function drawStageProp(
  g: Phaser.GameObjects.Graphics,
  art: DeliManArtTheme,
  x: number,
  y: number,
  variant: number,
) {
  if (art.prop === "fryer") {
    g.fillStyle(0x69717a).fillRect(x - 34, y - 45, 68, 42);
    g.fillStyle(0x1a1b1c).fillRect(x - 27, y - 37, 54, 13);
    g.fillStyle(art.glow, 0.85).fillRect(x - 22, y - 32, 44, 6);
    g.lineStyle(3, 0xb9c2c7).strokeRect(x - 34, y - 45, 68, 42);
  } else if (art.prop === "phone" || art.prop === "rush") {
    g.fillStyle(0xe9e3c8).fillRect(x - 28, y - 30, 56, 27);
    g.fillStyle(variant % 2 ? 0xf04455 : 0x7d62ff).fillRect(x - 22, y - 25, 44, 7);
    for (let p = 0; p < 4; p++) g.fillStyle(0x222533).fillRect(x - 20 + p * 12, y - 13, 7, 6);
  } else if (art.prop === "freezer") {
    for (let i = 0; i < 4; i++)
      g.fillStyle(0xe9fbff, 0.85).fillTriangle(x - 35 + i * 22, y - 3, x - 24 + i * 22, y + 18, x - 14 + i * 22, y - 3);
  } else if (art.prop === "dock") {
    g.fillStyle(0x39241d).fillRect(x - 38, y - 54, 8, 52).fillRect(x + 30, y - 54, 8, 52);
    g.fillStyle(art.glow, 0.9).fillCircle(x - 34, y - 59, 9).fillCircle(x + 34, y - 59, 9);
  } else if (art.prop === "gothic") {
    g.fillStyle(0x211c27).fillRect(x - 38, y - 42, 76, 39);
    g.lineStyle(3, art.edge).strokeRect(x - 38, y - 42, 76, 39);
    for (let s = 0; s < 5; s++) g.fillStyle(s ? 0x3f3946 : 0xffd438).fillCircle(x - 25 + s * 13, y - 22, 5);
  } else if (art.prop === "closing") {
    g.fillStyle(0x8e2424).fillRect(x - 34, y - 34, 68, 28);
    g.fillStyle(0xff534b).fillRect(x - 27, y - 28, 54, 15);
  } else if (art.prop === "office") {
    g.fillStyle(0x171b25).fillRect(x - 38, y - 48, 76, 45);
    g.fillStyle(variant % 2 ? 0x66eaff : 0xf04455).fillRect(x - 31, y - 40, 62, 25);
    g.fillStyle(0xa46d42).fillRect(x - 48, y - 7, 96, 6);
  } else if (art.prop === "street") {
    g.fillStyle(0x27323b).fillRect(x - 4, y - 60, 8, 58);
    g.fillStyle(0x2b8149).fillRect(x - 42, y - 75, 84, 27);
    g.lineStyle(3, 0xe8f2e6).strokeRect(x - 42, y - 75, 84, 27);
  }
}

function drawLargeProps(g: Phaser.GameObjects.Graphics, art: DeliManArtTheme) {
  for (let x = 340; x < 4450; x += 720) {
    if (art.prop === "phone" || art.prop === "rush") {
      g.fillStyle(0x242735).fillRect(x, 526, 126, 77);
      g.fillStyle(art.glow, 0.8).fillRect(x + 12, 536, 102, 38);
      for (let t = 0; t < 5 + (art.prop === "rush" ? 4 : 0); t++)
        g.fillStyle(0xf4efd9, 0.9).fillRect(x + 20 + (t % 3) * 28, 475 - (t % 2) * 23, 20, 60);
    } else if (art.prop === "freezer") {
      g.fillStyle(0x718e9e).fillRect(x, 488, 115, 115);
      g.fillStyle(0x182b3e).fillCircle(x + 58, 531, 35);
      for (let i = 0; i < 4; i++) g.fillStyle(0xb9edff).fillRect(x + 54, 496 + i * 20, 8, 34);
    } else if (art.prop === "dock") {
      g.fillStyle(0x352116).fillRect(x, 500, 10, 103).fillRect(x + 106, 500, 10, 103);
      g.fillStyle(art.glow).fillCircle(x + 5, 492, 13).fillCircle(x + 111, 492, 13);
    } else if (art.prop === "closing") {
      g.fillStyle(0x21536a).fillRect(x + 35, 535, 46, 68);
      g.fillStyle(0x9bdce8).fillRect(x + 28, 526, 60, 13);
      g.fillStyle(art.glow, 0.35).fillCircle(x + 58, 546, 65);
    } else if (art.prop === "office") {
      g.fillStyle(0x3d2119).fillRect(x, 548, 150, 55);
      g.fillStyle(0x161a23).fillRect(x + 35, 482, 80, 66);
      g.fillStyle(art.glow, 0.7).fillRect(x + 43, 490, 64, 48);
    } else if (art.prop === "gothic") {
      g.fillStyle(0x332e3b).fillRect(x, 488, 124, 115);
      g.fillStyle(0x15121a).fillCircle(x + 62, 518, 40);
      g.lineStyle(4, art.edge, 0.8).strokeCircle(x + 62, 518, 40);
    }
  }
}

function createAtmosphere(scene: Phaser.Scene, art: DeliManArtTheme) {
  const colors: Record<DeliManArtTheme["particle"], number> = {
    steam: 0xe6f4f3,
    tickets: 0xfff3c4,
    leaves: 0xd18b3e,
    frost: 0xcdf7ff,
    crumbs: 0xe0a14b,
    embers: 0xff7c26,
    dust: 0xb6a695,
    mist: 0xc3e4ed,
    paper: 0xf3e3b5,
  };
  const active = new Set<Phaser.GameObjects.Shape>();
  scene.time.addEvent({
    delay: art.particle === "tickets" || art.particle === "paper" ? 210 : 330,
    loop: true,
    callback: () => {
      if (active.size >= 18 || !scene.sys.isActive()) return;
      const camera = scene.cameras.main;
      const x = camera.scrollX + Math.random() * camera.width;
      const fromBottom = art.particle === "steam" || art.particle === "embers" || art.particle === "mist";
      const p = scene.add
        .rectangle(x, fromBottom ? 620 : -10, art.particle === "mist" ? 18 : 5 + Math.random() * 7, 3 + Math.random() * 8, colors[art.particle], 0.55)
        .setDepth(9)
        .setAngle(Math.random() * 90);
      active.add(p);
      scene.tweens.add({
        targets: p,
        x: x + (Math.random() - 0.5) * 170,
        y: fromBottom ? 300 + Math.random() * 180 : 650,
        alpha: 0,
        angle: p.angle + 180,
        duration: 1800 + Math.random() * 1800,
        onComplete: () => {
          active.delete(p);
          p.destroy();
        },
      });
    },
  });
}

export function createDeliManTextures(scene: Phaser.Scene, art: DeliManArtTheme) {
  const hero = (key: string, pose: "idle" | "runA" | "runB" | "jump" | "shoot" | "hurt") => {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    // Dark outline, deli cap, expressive face, shirt, apron, limbs and highlights.
    g.fillStyle(0x10151e).fillRect(9, 2, 28, 7).fillRect(5, 8, 36, 8);
    g.fillStyle(0xf04435).fillRect(10, 1, 27, 7).fillRect(6, 8, 34, 6);
    g.fillStyle(0xff7463).fillRect(11, 3, 17, 2);
    g.fillStyle(0x231816).fillRect(8, 14, 30, 18);
    g.fillStyle(0xf0b47f).fillRect(10, 15, 26, 15);
    g.fillStyle(0xffffff).fillRect(27, 18, 5, 4);
    g.fillStyle(0x17202a).fillRect(30, 19, 2, 3);
    g.fillStyle(0x12345a).fillRect(7, 31, 32, 18);
    g.fillStyle(0x2d6596).fillRect(9, 33, 27, 5);
    g.fillStyle(0xf3e4c2).fillRect(13, 36, 20, 20);
    g.fillStyle(0xd0b985).fillRect(13, 49, 20, 5);
    if (pose === "shoot") {
      g.fillStyle(0x10151e).fillRect(35, 33, 13, 11);
      g.fillStyle(0xf0b47f).fillRect(34, 35, 12, 7);
      g.fillStyle(art.glow).fillRect(45, 36, 5, 5);
    } else {
      g.fillStyle(0x10151e).fillRect(2, 33, 8, 18).fillRect(37, 33, 8, 18);
      g.fillStyle(0xf0b47f).fillRect(3, 34, 6, 14).fillRect(38, 34, 6, 14);
    }
    const runA = pose === "runA", runB = pose === "runB";
    g.fillStyle(0x10151e);
    if (pose === "jump") g.fillRect(10, 53, 13, 9).fillRect(27, 49, 13, 9);
    else if (pose === "hurt") g.fillRect(4, 51, 15, 10).fillRect(30, 51, 15, 10);
    else if (runA) g.fillRect(5, 53, 18, 9).fillRect(28, 50, 13, 9);
    else if (runB) g.fillRect(10, 50, 13, 9).fillRect(28, 53, 18, 9);
    else g.fillRect(9, 53, 14, 9).fillRect(27, 53, 14, 9);
    g.generateTexture(key, 50, 64);
    g.destroy();
  };
  hero("hero-idle", "idle");
  hero("hero-run-a", "runA");
  hero("hero-run-b", "runB");
  hero("hero-jump", "jump");
  hero("hero-shoot", "shoot");
  hero("hero-hurt", "hurt");

  const enemy = (key: string, step: boolean) => {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(art.shadow).fillCircle(27, 27, 26);
    g.fillStyle(shade(art.accent, step ? 24 : 0)).fillCircle(27, 25, 22);
    g.fillStyle(shade(art.accent, 45)).fillCircle(20, 17, 10);
    g.fillStyle(0xffffff).fillRect(13, 20, 10, 8).fillRect(31, 20, 10, 8);
    g.fillStyle(0x151515).fillRect(18, 22, 4, 5).fillRect(32, 22, 4, 5);
    g.fillStyle(0x231013).fillRect(15, 35, 25, 8);
    g.fillStyle(0xffffff).fillTriangle(18, 35, 22, 41, 25, 35).fillTriangle(31, 35, 35, 41, 38, 35);
    g.fillStyle(art.shadow).fillRect(step ? 3 : 8, 47, 19, 8).fillRect(step ? 32 : 28, step ? 44 : 47, 19, 8);
    g.generateTexture(key, 56, 56);
    g.destroy();
  };
  enemy("enemy", false);
  enemy("enemy-walk", true);

  const boss = scene.make.graphics({ x: 0, y: 0 }, false);
  boss.fillStyle(art.shadow).fillCircle(68, 74, 62);
  if (art.prop === "street") {
    // THE DOE: antlers and a sharp deer silhouette.
    boss.lineStyle(8, 0x342217).lineBetween(42, 42, 20, 8).lineBetween(42, 35, 8, 28);
    boss.lineBetween(94, 42, 116, 8).lineBetween(94, 35, 128, 28);
    boss.fillStyle(0x8b552f).fillEllipse(68, 72, 86, 98);
    boss.fillStyle(0xd5a065).fillEllipse(68, 89, 52, 40);
  } else if (art.prop === "freezer") {
    // FREEZER BURN: huge frozen chicken with ice crown and wings.
    boss.fillStyle(0xdffaff).fillTriangle(20, 36, 38, 3, 51, 42).fillTriangle(50, 36, 68, 0, 82, 41).fillTriangle(79, 38, 105, 6, 116, 47);
    boss.fillStyle(0x69b5d0).fillEllipse(68, 76, 95, 104);
    boss.fillStyle(0xb9efff).fillEllipse(18, 80, 38, 65).fillEllipse(118, 80, 38, 65);
  } else if (art.prop === "phone") {
    // INVALID MODIFIER: corrupted POS terminal with cable limbs.
    boss.fillStyle(0x26263a).fillRoundedRect(12, 18, 112, 102, 10);
    boss.lineStyle(6, art.edge).strokeRoundedRect(12, 18, 112, 102, 10);
    boss.fillStyle(0x140c22).fillRect(24, 32, 88, 56);
    boss.fillStyle(art.glow).fillRect(30, 39, 76, 9).fillRect(30, 58, 52, 7).fillRect(30, 75, 66, 6);
  } else if (art.prop === "rush") {
    // THE RUSH: sentient avalanche of tickets.
    boss.fillStyle(0xf5e6ba).fillRect(14, 20, 108, 103);
    for (let y = 29; y < 112; y += 14) boss.fillStyle(y % 28 ? 0xd64035 : 0x24212a).fillRect(24, y, 84, 5);
    boss.fillStyle(art.accent).fillTriangle(14, 20, 52, 5, 55, 22).fillTriangle(72, 21, 105, 2, 122, 20);
  } else if (art.prop === "dock") {
    // LAKE ONTARIO: a towering wave with a face in the foam.
    boss.fillStyle(0x134e78).fillCircle(68, 79, 57);
    boss.fillStyle(0x23a8c2).fillCircle(83, 63, 47);
    boss.lineStyle(12, 0xc8fbff).arc(68, 60, 52, 3.45, 6.05);
    boss.fillStyle(0xe5ffff).fillCircle(27, 43, 12).fillCircle(47, 28, 15).fillCircle(72, 24, 12);
  } else if (art.prop === "gothic") {
    // THE REVIEWER: a stone one-star tablet.
    boss.fillStyle(0x49434f).fillRoundedRect(13, 9, 110, 119, 9);
    boss.lineStyle(6, art.edge).strokeRoundedRect(13, 9, 110, 119, 9);
    boss.fillStyle(0xffd438).fillTriangle(68, 19, 77, 44, 105, 44).fillTriangle(105, 44, 82, 60, 91, 88).fillTriangle(91, 88, 68, 70, 45, 88).fillTriangle(45, 88, 54, 60, 31, 44).fillTriangle(31, 44, 59, 44, 68, 19);
  } else if (art.prop === "closing") {
    // LAST MINUTE ORDER: monstrous stack of boxes and ringing phone.
    boss.fillStyle(0xd8b071).fillRect(10, 46, 116, 78);
    boss.lineStyle(5, 0x5a2e22).strokeRect(10, 46, 116, 78);
    boss.fillStyle(0xd53b34).fillRect(20, 12, 96, 34);
    boss.fillStyle(0x17151b).fillRoundedRect(35, 3, 66, 22, 10);
  } else if (art.prop === "office") {
    // THE MARGIN: an enormous glowing calculator.
    boss.fillStyle(0x241824).fillRoundedRect(15, 5, 106, 128, 8);
    boss.lineStyle(6, art.edge).strokeRoundedRect(15, 5, 106, 128, 8);
    boss.fillStyle(0x26050b).fillRect(27, 17, 82, 30);
    boss.fillStyle(art.glow).fillRect(34, 24, 68, 15);
    for (let y = 58; y < 117; y += 22)
      for (let x = 31; x < 108; x += 25) boss.fillStyle(x > 80 ? art.accent : 0x75818b).fillRoundedRect(x, y, 17, 15, 3);
  } else {
    // FATHEAD: an infernal stock pot/fryer brute.
    boss.fillStyle(0x3b4248).fillRoundedRect(15, 36, 106, 92, 20);
    boss.fillStyle(0x8b969b).fillRect(10, 24, 116, 22);
    boss.fillStyle(art.glow).fillRect(20, 41, 96, 10);
    boss.lineStyle(6, art.shadow).strokeRoundedRect(15, 36, 106, 92, 20);
  }
  boss.fillStyle(0xffffff).fillCircle(47, 70, 12).fillCircle(89, 70, 12);
  boss.fillStyle(0x111111).fillCircle(51, 73, 5).fillCircle(93, 73, 5);
  if (art.prop !== "gothic") {
    boss.fillStyle(0x250d12).fillRect(39, 96, 58, 13);
    boss.fillStyle(0xffffff).fillTriangle(45, 96, 51, 105, 57, 96).fillTriangle(78, 96, 84, 105, 90, 96);
  }
  boss.generateTexture("boss", 136, 136);
  boss.destroy();
}
