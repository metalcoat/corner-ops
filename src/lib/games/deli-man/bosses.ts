import { bossFrame, type BossPose } from "./art/bosses";
import { MAX_HP, TILE } from "./constants";
import type { BossDef, BossId } from "./data";
import { moveBody, type Body } from "./physics";
import { draw, silhouette, sprite } from "./sprites";
import type { Stage } from "./stage";

/*
 * Boss AI is a small state machine. Each boss cycles through a pattern of
 * named attacks; the attack handlers read the boss id for flavour (what gets
 * thrown, how fast it moves).
 */

type Attack =
  | "jump"
  | "throw"
  | "plow"
  | "hop"
  | "dash"
  | "spread"
  | "fly"
  | "dive"
  | "coupon"
  | "leap"
  | "teleport"
  | "ring"
  | "thumbs"
  | "beam"
  | "summon"
  | "slash"
  | "percent"
  | "jumpover";

const PATTERNS: Record<BossId, Attack[]> = {
  pothole: ["jump", "throw", "jump", "jump", "throw"],
  snowbank: ["throw", "plow", "hop", "throw", "plow"],
  deer: ["dash", "hop", "spread", "dash", "spread"],
  goose: ["fly", "dive", "spread", "fly", "dive"],
  coupon: ["coupon", "coupon", "leap", "coupon", "hop"],
  complaint: ["spread", "teleport", "ring", "teleport", "spread"],
  admin: ["thumbs", "beam", "summon", "thumbs", "beam"],
  slasher: ["slash", "percent", "jumpover", "slash", "percent"],
  margin: ["dash", "ring", "thumbs", "throw", "jumpover", "beam", "summon"],
};

const THROWN = {
  pothole: "asphalt",
  snowbank: "snowball",
  margin: "coin",
} as const;

export class Boss implements Body {
  x: number;
  y: number;
  w = 20;
  h = 24;
  vx = 0;
  vy = 0;
  grounded = false;
  hp = 0;
  facing: 1 | -1 = -1;
  state: "enter" | "pose" | "idle" | Attack | "dead" = "enter";
  t = 0;
  step = 0;
  invuln = 0;
  pose: BossPose = "jump";
  visible = true;
  flying = false;
  counter = 0;
  def: BossDef;

  constructor(def: BossDef, x: number) {
    this.def = def;
    this.x = x;
    this.y = -30;
  }

  get cx() {
    return this.x + this.w / 2;
  }

  get speedUp() {
    return this.hp <= MAX_HP / 2;
  }

  private set(state: Boss["state"]) {
    this.state = state;
    this.t = 0;
    this.counter = 0;
  }

  private face(stage: Stage) {
    this.facing = stage.player.cx < this.cx ? -1 : 1;
  }

  private physics(stage: Stage) {
    if (!this.flying) this.vy = Math.min(this.vy + 0.3, 7);
    return moveBody(stage.level, this, { ladderTops: false });
  }

  private jumpTo(targetX: number, vy: number) {
    const air = (2 * -vy) / 0.3;
    this.vy = vy;
    this.vx = (targetX - this.cx) / air;
    this.grounded = false;
    this.pose = "jump";
  }

  update(stage: Stage) {
    this.t++;
    if (this.invuln > 0) this.invuln--;
    const room = stage.room();
    const p = stage.player;
    const fast = this.speedUp;
    switch (this.state) {
      case "enter": {
        this.pose = "jump";
        this.physics(stage);
        if (this.grounded) {
          stage.sfx("thud");
          this.set("pose");
        }
        return;
      }
      case "pose":
        this.pose = this.t < 30 ? "throw" : "stand";
        this.face(stage);
        return;
      case "dead":
        return;
      case "idle": {
        this.vx = 0;
        this.pose = "stand";
        this.face(stage);
        this.physics(stage);
        if (this.t > (fast ? 22 : 36)) {
          const pattern = PATTERNS[this.def.id];
          this.set(pattern[this.step % pattern.length]);
          this.step++;
        }
        return;
      }
      case "jump": {
        if (this.t === 1) this.jumpTo(p.cx, -6.6);
        const r = this.physics(stage);
        if (r.wall) this.vx = 0;
        if (this.t > 2 && this.grounded) {
          this.vx = 0;
          stage.shake = 18;
          stage.sfx("thud");
          stage.fireBullet("crack", this.cx - 8, room.floor - 8, -2.6, 0, { w: 16, h: 8 });
          stage.fireBullet("crack", this.cx - 8, room.floor - 8, 2.6, 0, { w: 16, h: 8 });
          this.set("idle");
        }
        return;
      }
      case "throw": {
        this.face(stage);
        this.physics(stage);
        this.pose = this.t % 20 > 6 && this.t < 50 ? "throw" : "stand";
        const kind = THROWN[this.def.id as keyof typeof THROWN] ?? "asphalt";
        if (this.t === 10 || this.t === 24 || (this.t === 38 && fast)) {
          const air = 44;
          const spread = this.t === 10 ? 1 : this.t === 24 ? 0.7 : 1.3;
          const vx = ((p.cx - this.cx) / air) * spread;
          stage.fireBullet(kind, this.cx - 4, this.y + 4, vx, -6.6, { gravity: 0.3 });
          stage.sfx("shoot");
        }
        if (this.t > 60) this.set("idle");
        return;
      }
      case "plow": {
        this.physics(stage);
        if (this.t < 24) {
          this.face(stage);
          this.pose = this.t % 6 < 3 ? "throw" : "stand";
          this.vx = 0;
          return;
        }
        this.pose = "throw";
        this.vx = this.facing * (fast ? 3.6 : 3);
        if (this.t % 5 === 0) stage.addEffect("dust", this.cx - this.facing * 10, room.floor);
        const r = this.physics(stage);
        if (r.wall || this.x <= room.left + 1 || this.x + this.w >= room.right - 1) {
          this.vx = 0;
          stage.shake = 12;
          stage.sfx("thud");
          for (let i = 0; i < 3; i++) {
            const ix = room.left + 24 + ((i * 67 + this.step * 41) % (room.right - room.left - 48));
            stage.fireBullet("icicle", ix, 18, 0, 0, { w: 8, h: 14, life: 400, a: 36 + i * 12 });
          }
          this.set("idle");
        }
        return;
      }
      case "hop": {
        if (this.t === 1 || (this.grounded && this.counter < 2 && this.t > 4)) {
          this.counter++;
          this.face(stage);
          this.jumpTo(this.cx + this.facing * 48, -5);
        }
        const r = this.physics(stage);
        if (r.wall) this.vx = 0;
        if (this.grounded && this.counter >= 2 && this.t > 10) this.set("idle");
        else if (this.grounded) this.pose = "stand";
        return;
      }
      case "dash": {
        this.physics(stage);
        if (this.t < 28) {
          this.vx = 0;
          this.face(stage);
          this.pose = "stand";
          return;
        }
        this.vx = this.facing * (fast ? 5 : 4.2);
        this.pose = "throw";
        if (this.t % 4 === 0) stage.addEffect("dust", this.cx - this.facing * 10, room.floor);
        const r = this.physics(stage);
        if (r.wall || this.x <= room.left + 1 || this.x + this.w >= room.right - 1) {
          this.vx = 0;
          stage.shake = 8;
          stage.sfx("thud");
          this.set("idle");
        }
        return;
      }
      case "spread": {
        this.physics(stage);
        this.face(stage);
        this.pose = this.t > 10 && this.t < 30 ? "throw" : "stand";
        const kind = this.def.id === "complaint" ? "bubble" : this.def.id === "goose" ? "egg" : "antler";
        if (this.t === 14 || (fast && this.t === 34)) {
          for (const vy of [-1.2, 0, 1.2])
            stage.fireBullet(kind, this.cx + this.facing * 10 - 4, this.y + 8, this.facing * 2.4, vy, { w: 8, h: 8 });
          stage.sfx(this.def.id === "goose" ? "honk" : "shoot");
        }
        if (this.t > 50) this.set("idle");
        return;
      }
      case "fly": {
        this.flying = true;
        this.pose = "jump";
        if (this.y > 40 && this.t < 60) {
          this.vy = -2.2;
          this.vx = 0;
        } else {
          this.vy = Math.sin(this.t / 10) * 0.8;
          if (this.vx === 0) this.vx = this.facing * (fast ? 2 : 1.5);
        }
        const r = this.physics(stage);
        if (r.wall || this.x <= room.left + 2 || this.x + this.w >= room.right - 2) {
          this.vx = -this.vx;
          this.x += this.vx * 2;
        }
        this.facing = this.vx < 0 ? -1 : 1;
        if (this.t % (fast ? 24 : 32) === 0 && this.y < 80)
          stage.fireBullet("egg", this.cx - 4, this.y + this.h, 0, 0, { w: 8, h: 9, gravity: 0.2 });
        if (this.t > 170) this.set("dive");
        return;
      }
      case "dive": {
        if (this.t < 20) {
          this.vx = 0;
          this.vy = 0;
          if (this.t === 2) stage.sfx("honk");
          this.face(stage);
          return;
        }
        if (this.t === 20) {
          const dx = p.cx - this.cx;
          const dy = p.y - this.y;
          const d = Math.hypot(dx, dy) || 1;
          this.vx = (dx / d) * 4.5;
          this.vy = (dy / d) * 4.5;
        }
        const r = this.physics(stage);
        if (r.landed || this.grounded || this.t > 90) {
          this.flying = false;
          this.vx = 0;
          stage.shake = 10;
          stage.sfx("thud");
          this.set("idle");
        } else if (r.wall) this.vx = 0;
        return;
      }
      case "coupon": {
        this.physics(stage);
        this.face(stage);
        this.pose = this.t > 8 && this.t < 24 ? "throw" : "stand";
        if (this.t === 12) {
          stage.fireBullet("coupon", this.cx - 6, this.y + 6, this.facing * 4.2, 0, { w: 12, h: 8, a: this.facing, life: 240 });
          stage.sfx("shoot");
        }
        if (this.t > (fast ? 50 : 70)) this.set("idle");
        return;
      }
      case "leap": {
        if (this.t === 1) {
          const target = this.cx < (room.left + room.right) / 2 ? room.right - 30 : room.left + 30;
          this.jumpTo(target, -7);
        }
        if (this.counter === 0 && this.vy > -0.5 && !this.grounded) {
          this.counter = 1;
          const dx = p.cx - this.cx;
          const dy = p.y + 10 - this.y;
          const d = Math.hypot(dx, dy) || 1;
          stage.fireBullet("coupon", this.cx - 6, this.y + 8, (dx / d) * 3, (dy / d) * 3, { w: 12, h: 8, a: 0, life: 200 });
          this.pose = "throw";
        }
        this.physics(stage);
        if (this.grounded && this.t > 4) {
          this.vx = 0;
          this.set("idle");
        }
        return;
      }
      case "teleport": {
        this.vx = 0;
        if (this.t < 24) {
          this.visible = this.t % 4 < 2;
          this.invuln = Math.max(this.invuln, 2);
        } else if (this.t === 24) {
          this.visible = false;
          const leftSide = p.cx > (room.left + room.right) / 2;
          this.x = leftSide ? room.left + 24 : room.right - 24 - this.w;
          this.y = room.floor - this.h;
          this.invuln = 2;
        } else if (this.t < 48) {
          this.visible = this.t % 4 < 2;
          this.invuln = Math.max(this.invuln, 2);
        } else {
          this.visible = true;
          this.set("idle");
        }
        return;
      }
      case "ring": {
        this.physics(stage);
        this.pose = this.t > 10 && this.t < 40 ? "throw" : "stand";
        if (this.t === 4) stage.addEffect("text", this.cx, this.y - 10, { text: this.def.id === "margin" ? "SYNERGY!" : "MANAGER!", color: "#f8b800" });
        if (this.t === 22) {
          const n = fast ? 10 : 8;
          for (let i = 0; i < n; i++) {
            const angle = (i / n) * Math.PI * 2;
            stage.fireBullet("bubble", this.cx - 4, this.y + 8, Math.cos(angle) * 1.9, Math.sin(angle) * 1.9, { w: 8, h: 8 });
          }
          stage.sfx("bigShot");
        }
        if (this.t > 56) this.set("idle");
        return;
      }
      case "thumbs": {
        this.physics(stage);
        this.face(stage);
        this.pose = this.t % 30 > 5 && this.t % 30 < 18 ? "throw" : "stand";
        if (this.t === 10 || this.t === 40 || (fast && this.t === 70)) {
          stage.fireBullet("thumb", this.cx - 5, this.y + 4, this.facing * 1.5, -1, { w: 10, h: 10, life: 200 });
          stage.sfx("shoot");
        }
        if (this.t > (fast ? 90 : 70)) this.set("idle");
        return;
      }
      case "beam": {
        this.physics(stage);
        this.pose = "throw";
        if (this.t === 1) stage.addEffect("text", this.cx, this.y - 10, { text: "BANNED", color: "#d82800" });
        if (this.t === 44) {
          stage.fireBullet("beam", room.left, room.floor - 13, 0, 0, { w: room.right - room.left, h: 9, life: 22, dmg: 5 });
          stage.sfx("bigShot");
        }
        stage.warnBeam = this.t < 44 ? room.floor - 13 : -1;
        if (this.t > 76) {
          stage.warnBeam = -1;
          this.set("idle");
        }
        return;
      }
      case "summon": {
        this.physics(stage);
        this.pose = this.t < 20 ? "throw" : "stand";
        if (this.t === 12 && stage.enemies.filter((e) => e.kind === "m").length < 3) {
          stage.spawnMinion(room.left + 20, 30);
          stage.spawnMinion(room.right - 30, 30);
          stage.sfx("select");
        }
        if (this.t > 40) this.set("idle");
        return;
      }
      case "slash": {
        this.physics(stage);
        if (this.t < 18) {
          this.face(stage);
          this.vx = 0;
          this.pose = this.t % 4 < 2 ? "throw" : "stand";
          return;
        }
        if (this.t === 18) {
          stage.fireBullet("slashwave", this.cx, this.y, 0, 0, { w: 22, h: 24, life: 24, a: 1 });
          stage.sfx("midShot");
        }
        this.vx = this.t < 42 ? this.facing * 4.4 : 0;
        this.pose = "throw";
        const r = this.physics(stage);
        if (r.wall) this.vx = 0;
        if (this.t > 54) this.set("idle");
        return;
      }
      case "percent": {
        this.physics(stage);
        this.face(stage);
        this.pose = (this.t > 8 && this.t < 18) || (this.t > 26 && this.t < 36) ? "throw" : "stand";
        if (this.t === 12) stage.fireBullet("percent", this.cx - 5, this.y + 2, this.facing * 3, 0, { w: 10, h: 10 });
        if (this.t === 30) stage.fireBullet("percent", this.cx - 5, room.floor - 11, this.facing * 3, 0, { w: 10, h: 10 });
        if (fast && this.t === 44) stage.fireBullet("percent", this.cx - 5, this.y + 2, this.facing * 3.4, 0, { w: 10, h: 10 });
        if (this.t > 58) this.set("idle");
        return;
      }
      case "jumpover": {
        if (this.t === 1) {
          const side = p.cx > this.cx ? 1 : -1;
          const target = Math.max(room.left + 20, Math.min(room.right - 20, p.cx + side * 48));
          this.jumpTo(target, -6.6);
        }
        const r = this.physics(stage);
        if (r.wall) this.vx = 0;
        if (this.grounded && this.t > 4) {
          this.vx = 0;
          this.set("idle");
        }
        return;
      }
    }
  }

  /** Called by the stage once the intro health fill has finished. */
  begin() {
    this.set("idle");
  }

  kill() {
    this.state = "dead";
    this.visible = false;
  }

  draw(ctx: CanvasRenderingContext2D, camX: number, frame: number, shakeY: number) {
    if (!this.visible) return;
    if (this.invuln > 0 && this.state !== "teleport" && frame % 4 < 2) return;
    const key = `${this.def.id}:${this.pose}`;
    const rows = bossFrame(this.def.head, this.pose);
    const colors = { A: this.def.A, a: this.def.a, Z: this.def.Z };
    const telegraph =
      (this.state === "dash" && this.t < 28 && this.t % 6 < 3) ||
      (this.state === "slash" && this.t < 18 && this.t % 4 < 2) ||
      (this.state === "plow" && this.t < 24 && this.t % 6 < 3);
    const s = telegraph ? silhouette(key, rows, "#f8b800") : sprite(`boss:${key}`, rows, colors);
    const left = this.facing < 0;
    draw(ctx, s, this.cx - 12 - camX, this.y + this.h - 24 + shakeY, !left);
  }
}

export function bossRoomFloor(doorCol: number) {
  return { left: (doorCol + 1) * TILE, right: (doorCol + 15) * TILE, floor: 12 * TILE };
}
