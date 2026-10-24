import { ANCHOR_X, FRAME_H, MUZZLE, playerFrame, type PlayerPose } from "./art/player";
import { MAX_ENERGY, MAX_HP, PHYS, SCREEN_H, SCREEN_W, TILE } from "./constants";
import { WEAPONS, WEAPON_ORDER, type WeaponId } from "./data";
import type { Input } from "./input";
import { Tile, tileAt } from "./levels";
import { moveBody, type Body } from "./physics";
import { draw, sprite } from "./sprites";
import type { Stage } from "./stage";
import { CHARGE_1, CHARGE_2, handleFire } from "./weapons";

export type PlayerState = "normal" | "climb" | "hurt" | "dead";

export function fullEnergy(): Record<WeaponId, number> {
  return Object.fromEntries(WEAPON_ORDER.map((id) => [id, MAX_ENERGY])) as Record<WeaponId, number>;
}

export class Player implements Body {
  x: number;
  y: number;
  w = 14;
  h = 22;
  vx = 0;
  vy = 0;
  grounded = false;
  facing: 1 | -1 = 1;
  hp = MAX_HP;
  state: PlayerState = "normal";
  weapon: WeaponId = "buster";
  energy: Record<WeaponId, number>;
  charge = 0;
  shootPose = 0;
  invuln = 0;
  hurtT = 0;
  walkFrames = 0;
  animT = 0;
  climbT = 0;
  ladderX = 0;
  /** Disable input (door transitions, victory). */
  frozen = false;

  constructor(x: number, y: number, energy: Record<WeaponId, number>) {
    this.x = x;
    this.y = y;
    this.energy = energy;
  }

  get cx() {
    return this.x + this.w / 2;
  }

  muzzle() {
    const top = this.y + this.h - FRAME_H;
    const mx = this.facing > 0 ? this.cx + (MUZZLE.x - ANCHOR_X) : this.cx - (MUZZLE.x - ANCHOR_X);
    return { x: mx, y: top + MUZZLE.y };
  }

  hurt(stage: Stage, dmg: number) {
    if (this.invuln > 0 || this.state === "dead") return;
    this.hp = Math.max(0, this.hp - dmg);
    stage.sfx("hurt");
    if (this.hp <= 0) {
      stage.killPlayer();
      return;
    }
    this.state = "hurt";
    this.hurtT = PHYS.hurtFrames;
    this.invuln = PHYS.hurtFrames + PHYS.invulnFrames;
    this.charge = 0;
    this.vy = Math.min(this.vy, 0);
    stage.addEffect("spark", this.cx, this.y + 6);
  }

  private ladderUnder(stage: Stage, y: number) {
    return tileAt(stage.level, Math.floor(this.cx / TILE), Math.floor(y / TILE)) === Tile.Ladder;
  }

  private grabLadder(y: number) {
    this.state = "climb";
    this.ladderX = Math.floor(this.cx / TILE) * TILE + TILE / 2;
    this.x = this.ladderX - this.w / 2;
    this.vx = 0;
    this.vy = 0;
    this.y = y;
    this.charge = 0;
  }

  update(stage: Stage, input: Input) {
    if (this.state === "dead") return;
    if (this.invuln > 0) this.invuln--;
    if (this.shootPose > 0) this.shootPose--;
    const level = stage.level;

    if (this.state === "hurt") {
      this.hurtT--;
      this.vx = -this.facing * PHYS.hurtPush;
      this.vy = Math.min(this.vy + PHYS.gravity, PHYS.maxFall);
      const r = moveBody(level, this);
      if (r.spike && this.invuln <= 0) stage.killPlayer();
      if (this.hurtT <= 0) this.state = "normal";
      this.clamp(stage);
      return;
    }

    const left = !this.frozen && input.held("left");
    const right = !this.frozen && input.held("right");
    const up = !this.frozen && input.held("up");
    const down = !this.frozen && input.held("down");

    if (this.state === "climb") {
      if (left) this.facing = -1;
      if (right) this.facing = 1;
      if (!this.frozen && input.pressed("jump")) {
        this.state = "normal";
        this.vy = 0;
      } else {
        const dir = this.shootPose > 0 ? 0 : up ? -1 : down ? 1 : 0;
        this.vy = dir * PHYS.climb;
        if (dir !== 0) this.climbT++;
        this.y += this.vy;
        this.x = this.ladderX - this.w / 2;
        const col = Math.floor(this.cx / TILE);
        const feetRow = Math.floor((this.y + this.h) / TILE);
        if (dir > 0 && tileAt(level, col, feetRow) !== Tile.Ladder && tileAt(level, col, feetRow) !== Tile.Air) {
          // reached the floor at the bottom of the ladder
          this.y = feetRow * TILE - this.h;
          this.state = "normal";
        } else if (dir < 0 && !this.ladderUnder(stage, this.y + this.h - 6)) {
          // climbed past the top: stand on the ladder top
          const topRow = Math.floor((this.y + this.h) / TILE);
          this.y = topRow * TILE - this.h;
          this.state = "normal";
          this.grounded = true;
        } else if (!this.ladderUnder(stage, this.y + this.h - 2) && !this.ladderUnder(stage, this.y + 4)) {
          this.state = "normal";
        }
      }
      if (!this.frozen) handleFire(stage, this, input);
      this.checkPit(stage);
      return;
    }

    // ---- normal ----
    const dir = left === right ? 0 : left ? -1 : 1;
    if (dir !== 0) {
      this.facing = dir;
      this.walkFrames++;
      const speed = this.grounded && this.walkFrames <= PHYS.tiptoeFrames ? PHYS.tiptoe : PHYS.walk;
      this.vx = dir * speed;
      this.animT++;
    } else {
      this.vx = 0;
      this.walkFrames = 0;
      this.animT = 0;
    }

    if (up && this.ladderUnder(stage, this.y + this.h / 2)) {
      this.grabLadder(this.y);
      return;
    }
    if (down && this.grounded && this.ladderUnder(stage, this.y + this.h + 2)) {
      this.grabLadder(this.y + 6);
      return;
    }

    if (!this.frozen && input.pressed("jump") && this.grounded) {
      this.vy = PHYS.jump;
      this.grounded = false;
    }
    // Mega Man style variable jump: letting go kills upward speed instantly.
    if (this.vy < 0 && (this.frozen || !input.held("jump"))) this.vy = 0;
    this.vy = Math.min(this.vy + PHYS.gravity, PHYS.maxFall);

    const wasGrounded = this.grounded;
    const r = moveBody(level, this);
    if (r.landed && !wasGrounded) {
      stage.sfx("land");
      stage.addEffect("dust", this.cx, this.y + this.h);
    }
    if (r.door) stage.openDoor();
    if (r.spike && this.invuln <= 0) {
      stage.killPlayer();
      return;
    }
    this.clamp(stage);
    if (!this.frozen) handleFire(stage, this, input);
    this.checkPit(stage);
  }

  private clamp(stage: Stage) {
    const min = stage.camX;
    const max = stage.camX + SCREEN_W - this.w;
    if (this.x < min) this.x = min;
    if (this.x > max && !stage.doorOpening) this.x = max;
  }

  private checkPit(stage: Stage) {
    if (this.y > SCREEN_H + 4) stage.killPlayer();
  }

  pose(): PlayerPose {
    if (this.state === "hurt") return "hurt";
    if (this.state === "climb") return "climb";
    if (!this.grounded) return "jump";
    if (this.vx === 0) return "idle";
    if (this.walkFrames <= PHYS.tiptoeFrames) return "run2";
    const cycle: PlayerPose[] = ["run1", "run2", "run3", "run2"];
    return cycle[Math.floor(this.animT / 7) % 4];
  }

  draw(ctx: CanvasRenderingContext2D, camX: number, frame: number, shakeY = 0) {
    if (this.state === "dead") return;
    if (this.invuln > 0 && this.state !== "hurt" && frame % 4 < 2) return;
    const pose = this.pose();
    const shooting = this.shootPose > 0 && pose !== "hurt";
    const weapon = WEAPONS[this.weapon];
    let colors: Record<string, string> = { B: weapon.primary, b: weapon.secondary };
    let key = this.weapon;
    if (this.charge >= CHARGE_1 && this.weapon === "buster") {
      const fast = this.charge >= CHARGE_2;
      const phase = Math.floor(frame / (fast ? 2 : 4)) % (fast ? 3 : 2);
      if (fast) {
        const sets: Record<string, string>[] = [
          { B: "#f8b800", b: "#c84c0c", K: "#000000" },
          { B: "#58d854", b: "#007800", K: "#fcfcfc" },
          { B: weapon.primary, b: weapon.secondary },
        ];
        colors = sets[phase];
        key = `buster-c2-${phase}` as WeaponId;
      } else if (phase === 0) {
        colors = { B: "#3cbcfc", b: "#0078f8", K: "#3cbcfc" };
        key = "buster-c1" as WeaponId;
      }
    }
    if (this.state === "hurt" && frame % 4 < 2) {
      colors = { ...colors, W: "#fcfcfc", S: "#fcfcfc", R: "#fcfcfc", B: "#fcfcfc", b: "#bcbcbc" };
      key = `${key}-hurtflash` as WeaponId;
    }
    const rows = playerFrame(pose, shooting);
    let facingLeft = this.facing < 0;
    if (pose === "climb" && !shooting) facingLeft = Math.floor(this.climbT / 8) % 2 === 1;
    const s = sprite(`p:${key}:${pose}:${shooting}`, rows, colors);
    const anchor = facingLeft ? s.w - ANCHOR_X : ANCHOR_X;
    const dx = this.cx - anchor - camX;
    const dy = this.y + this.h - FRAME_H + shakeY;
    draw(ctx, s, dx, dy, facingLeft);
  }
}
