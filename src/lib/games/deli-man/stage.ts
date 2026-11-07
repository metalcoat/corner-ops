import { MUSTARD_BIG, MUSTARD_SMALL, ORB_A, ORB_B, PICKLE_BIG, PICKLE_CHIP, EXPLOSION } from "./art/enemies";
import { HEAD_ICON } from "./art/player";
import type { DeliManAudio, SfxName } from "./audio";
import { Boss } from "./bosses";
import { drawBullet, makeBullet, updateBullet } from "./bullets";
import { MAX_ENERGY, MAX_HP, ROWS, SCREEN_H, SCREEN_W, TILE } from "./constants";
import { bossDamage, WEAPONS, type BossDef, type WeaponId } from "./data";
import { drawEnemy, spawnEnemy, updateEnemy } from "./enemies";
import { makeBody, type Bullet, type BulletKind, type Effect, type EffectKind, type Enemy, type EnemyKind, type Item, type ItemKind, type Shot } from "./entities";
import { drawText } from "./font";
import { drawBar, drawLives } from "./hud";
import type { Input } from "./input";
import { buildLevel, setTile, Tile, tileAt, type Level } from "./levels";
import { moveBody, overlap } from "./physics";
import { Player } from "./player";
import { draw, sprite } from "./sprites";
import { BACKDROP_W, tileset, type Tileset } from "./tiles";
import { drawShot, SHIELD_PIERCING, updateShot } from "./weapons";

export type StageMode = "ready" | "play" | "door" | "bossIntro" | "fill" | "bossDead" | "dead" | "exit";

export type StageResult = null | "dead" | "victory";

const MUSIC = ["stage0", "stage1", "stage2", "stage3", "stage4"] as const;

/** One attempt at a stage, from READY until death or victory. */
export class Stage {
  readonly def: BossDef;
  readonly level: Level;
  readonly tiles: Tileset;
  readonly player: Player;
  shots: Shot[] = [];
  bullets: Bullet[] = [];
  enemies: Enemy[] = [];
  items: Item[] = [];
  effects: Effect[] = [];
  boss: Boss | null = null;
  camX = 0;
  frame = 0;
  mode: StageMode = "ready";
  modeT = 0;
  shake = 0;
  shakeY = 0;
  flash = 0;
  warnBeam = -1;
  result: StageResult = null;
  checkpoint: number;
  lives: number;
  doorProgress = 0;
  doorOpening = false;
  inBossRoom = false;
  bossFill = 0;
  pendingHeal = 0;
  private spawnArmed = new Map<number, boolean>();
  private spawnAlive = new Set<number>();
  private collected: Set<number>;
  private audio: DeliManAudio;
  private doorFrom = 0;
  private doorPlayerFrom = 0;

  constructor(
    def: BossDef,
    opts: {
      checkpoint: number;
      energy: Record<WeaponId, number>;
      weapon: WeaponId;
      lives: number;
      collected: Set<number>;
      audio: DeliManAudio;
    },
  ) {
    this.def = def;
    this.level = buildLevel(def);
    this.tiles = tileset(def.theme);
    this.audio = opts.audio;
    this.checkpoint = opts.checkpoint;
    this.lives = opts.lives;
    this.collected = opts.collected;
    const spot = opts.checkpoint >= 0 ? this.level.checkpoints[opts.checkpoint] : this.level.start;
    this.player = new Player(spot.x, spot.y, opts.energy);
    this.player.weapon = opts.weapon;
    this.camX = this.cameraTarget();
    for (const item of this.level.items) {
      if (this.collected.has(item.id)) continue;
      this.items.push({ ...makeBody(item.x + 3, item.y + 4, 10, 12), kind: item.kind as ItemKind, ttl: -1, placedId: item.id, dead: false });
    }
    this.audio.play(MUSIC[def.music] ?? "stage0");
  }

  /* ---------------- services used by entities ---------------- */

  sfx(name: SfxName) {
    this.audio.sfx(name);
  }

  addEffect(kind: EffectKind, x: number, y: number, opts: Partial<Effect> = {}) {
    const life = { explode: 12, orb: 240, spark: 8, dust: 12, text: 60, charge: 10 }[kind];
    this.effects.push({ kind, x, y, vx: 0, vy: 0, t: 0, life, ...opts });
  }

  fireBullet(kind: BulletKind, x: number, y: number, vx: number, vy: number, opts: Partial<Bullet> = {}) {
    this.bullets.push(makeBullet(kind, x, y, vx, vy, opts));
  }

  spawnMinion(x: number, y: number) {
    spawnEnemy(this, "m", x, y);
  }

  room() {
    const left = (this.level.doorCol + 1) * TILE;
    return { left, right: left + 14 * TILE, floor: 12 * TILE };
  }

  nearestTarget(x: number, y: number) {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    const consider = (tx: number, ty: number) => {
      const d = Math.hypot(tx - x, ty - y);
      if (d < bestD) {
        bestD = d;
        best = { x: tx, y: ty };
      }
    };
    for (const e of this.enemies) if (!e.dead && this.onScreen(e)) consider(e.x + e.w / 2, e.y + e.h / 2);
    if (this.boss && this.boss.visible && this.boss.state !== "dead") consider(this.boss.cx, this.boss.y + 12);
    return best as { x: number; y: number } | null;
  }

  onScreen(b: { x: number; w: number }) {
    return b.x + b.w > this.camX && b.x < this.camX + SCREEN_W;
  }

  killPlayer() {
    if (this.mode === "dead" || this.player.state === "dead") return;
    const p = this.player;
    p.state = "dead";
    p.hp = 0;
    this.mode = "dead";
    this.modeT = 0;
    this.audio.stopMusic();
    this.sfx("death");
    if (p.y < SCREEN_H) this.burst(p.cx, p.y + 11);
  }

  private burst(x: number, y: number) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.addEffect("orb", x - 4, y - 4, { vx: Math.cos(a) * 2, vy: Math.sin(a) * 2 });
      this.addEffect("orb", x - 4, y - 4, { vx: Math.cos(a) * 1, vy: Math.sin(a) * 1 });
    }
  }

  openDoor() {
    if (this.mode !== "play" || this.inBossRoom) return;
    this.mode = "door";
    this.modeT = 0;
    this.doorOpening = true;
    this.doorFrom = this.camX;
    this.doorPlayerFrom = this.player.x;
    this.player.vx = 0;
    this.player.charge = 0;
    this.shots = [];
    this.sfx("door");
  }

  managerCall() {
    this.flash = 18;
    this.shake = 10;
    this.sfx("explode");
    this.addEffect("text", this.player.cx, this.player.y - 12, { text: "MANAGER!", color: "#f878f8" });
    for (const e of this.enemies) if (!e.dead && this.onScreen(e)) this.damageEnemy(e, 3);
    if (this.boss && this.boss.state !== "dead" && this.bossActive()) this.damageBoss("manager", 0);
  }

  bossActive() {
    return !!this.boss && this.mode === "play" && !["enter", "pose", "dead"].includes(this.boss.state);
  }

  /** Development helper: finish the boss off with one hit. */
  debugDefeatBoss() {
    if (!this.boss || !this.bossActive()) return;
    this.boss.hp = 1;
    this.boss.invuln = 0;
    this.damageBoss("buster", 0);
  }

  /* ---------------- update ---------------- */

  private cameraTarget() {
    if (this.inBossRoom) return this.level.doorCol * TILE;
    const max = (this.level.doorCol + 1) * TILE - SCREEN_W;
    return Math.max(0, Math.min(max, Math.round(this.player.cx - SCREEN_W / 2)));
  }

  update(input: Input) {
    this.frame++;
    this.modeT++;
    if (this.shake > 0) {
      this.shake--;
      this.shakeY = this.shake > 0 ? (this.frame % 4 < 2 ? 2 : -2) : 0;
    }
    if (this.flash > 0) this.flash--;
    switch (this.mode) {
      case "ready":
        if (this.modeT === 1) this.sfx("ready");
        if (this.modeT >= 96) {
          this.mode = "play";
          this.modeT = 0;
        }
        this.updateEffects();
        return;
      case "fill":
        if (this.modeT % 3 === 0) {
          if (this.pendingHeal > 0 && this.player.hp < MAX_HP) {
            this.player.hp++;
            this.pendingHeal--;
            this.sfx("tick");
          } else {
            this.pendingHeal = 0;
            this.mode = "play";
          }
        }
        return;
      case "door":
        this.updateDoor();
        return;
      case "bossIntro":
        this.updateBossIntro();
        this.updateEffects();
        return;
      case "dead":
        this.updateEffects();
        this.updateBullets();
        if (this.modeT > 200) this.result = "dead";
        return;
      case "bossDead":
        this.updateEffects();
        if (this.modeT === 150) this.audio.play("victory");
        if (this.modeT > 300) {
          this.mode = "exit";
          this.modeT = 0;
          this.sfx("weapon");
        }
        return;
      case "exit":
        if (this.modeT > 50) this.result = "victory";
        return;
      case "play":
        break;
    }

    this.player.update(this, input);
    if (this.mode !== "play") return;
    if (!this.inBossRoom) this.camX = this.cameraTarget();
    this.level.checkpoints.forEach((cp, index) => {
      if (index > this.checkpoint && this.player.x >= cp.x) this.checkpoint = index;
    });
    this.spawnEnemies();
    for (const shot of this.shots) updateShot(this, shot);
    for (const e of this.enemies) {
      updateEnemy(this, e);
      if (e.x + e.w < this.camX - 48 || e.x > this.camX + SCREEN_W + 48) {
        e.dead = true;
        this.spawnAlive.delete(e.spawnId);
      }
    }
    if (this.boss) this.boss.update(this);
    this.updateBullets();
    this.updateItems();
    this.collide();
    this.updateEffects();
    this.shots = this.shots.filter((s) => !s.dead);
    this.enemies = this.enemies.filter((e) => !e.dead);
  }

  private updateBullets() {
    for (const b of this.bullets) updateBullet(this, b);
    this.bullets = this.bullets.filter((b) => !b.dead);
  }

  private updateEffects() {
    for (const fx of this.effects) {
      fx.t++;
      fx.x += fx.vx;
      fx.y += fx.vy;
      if (fx.kind === "dust") fx.y -= 0.3;
      if (fx.kind === "text") fx.y -= 0.4;
    }
    this.effects = this.effects.filter((fx) => fx.t < fx.life);
  }

  private spawnEnemies() {
    if (this.inBossRoom) return;
    for (const spawn of this.level.spawns) {
      const inView = spawn.x + TILE > this.camX - 4 && spawn.x < this.camX + SCREEN_W + 4;
      if (!inView) {
        if (!this.spawnAlive.has(spawn.id)) this.spawnArmed.set(spawn.id, true);
        continue;
      }
      const armed = this.spawnArmed.get(spawn.id) ?? true;
      if (armed && !this.spawnAlive.has(spawn.id)) {
        this.spawnArmed.set(spawn.id, false);
        this.spawnAlive.add(spawn.id);
        spawnEnemy(this, spawn.kind as EnemyKind, spawn.x, spawn.y, spawn.id);
      }
    }
  }

  private updateItems() {
    for (const item of this.items) {
      if (item.ttl > 0) {
        item.ttl--;
        if (item.ttl === 0) item.dead = true;
      }
      item.vy = Math.min(item.vy + 0.25, 5);
      moveBody(this.level, item);
      if (item.y > SCREEN_H) item.dead = true;
      if (!item.dead && this.player.state !== "dead" && overlap(item, this.player)) this.collect(item);
    }
    this.items = this.items.filter((i) => !i.dead);
  }

  private collect(item: Item) {
    item.dead = true;
    if (item.placedId >= 0) this.collected.add(item.placedId);
    const p = this.player;
    switch (item.kind) {
      case "e":
      case "E": {
        const amount = item.kind === "e" ? 2 : 10;
        if (p.hp < MAX_HP) {
          this.pendingHeal = amount;
          this.mode = "fill";
          this.modeT = 0;
        } else this.sfx("pickup");
        break;
      }
      case "w":
      case "W": {
        const amount = item.kind === "w" ? 2 : 10;
        let target: WeaponId = p.weapon;
        if (target === "buster") {
          // Top up whichever special weapon is lowest.
          const owned = (Object.keys(p.energy) as WeaponId[]).filter((id) => id !== "buster" && this.ownsWeapon(id));
          target = owned.sort((a, b) => p.energy[a] - p.energy[b])[0] ?? "buster";
        }
        p.energy[target] = Math.min(MAX_ENERGY, p.energy[target] + amount);
        this.sfx("tick");
        break;
      }
      case "U":
        this.lives = Math.min(9, this.lives + 1);
        this.sfx("oneUp");
        break;
    }
  }

  ownedWeapons: WeaponId[] = ["buster"];

  private ownsWeapon(id: WeaponId) {
    return this.ownedWeapons.includes(id);
  }

  private dropItem(x: number, y: number) {
    const r = Math.random();
    let kind: ItemKind | null = null;
    if (r < 0.05) kind = "E";
    else if (r < 0.2) kind = "e";
    else if (r < 0.25) kind = "W";
    else if (r < 0.37) kind = "w";
    else if (r < 0.385) kind = "U";
    if (!kind) return;
    this.items.push({ ...makeBody(x - 5, y - 6, 10, 10), vy: -2, kind, ttl: 360, placedId: -1, dead: false });
  }

  private damageEnemy(e: Enemy, dmg: number) {
    e.hp -= dmg;
    e.flash = 8;
    if (e.hp <= 0) {
      e.dead = true;
      this.spawnAlive.delete(e.spawnId);
      this.addEffect("explode", e.x + e.w / 2 - 8, e.y + e.h / 2 - 6);
      this.sfx("enemyDie");
      this.dropItem(e.x + e.w / 2, e.y + e.h / 2);
      return true;
    }
    this.sfx("hit");
    return false;
  }

  private damageBoss(weapon: WeaponId, charge: number) {
    const boss = this.boss!;
    if (boss.invuln > 0) return false;
    const dmg = bossDamage(this.def, weapon, charge);
    if (dmg <= 0) {
      this.sfx("tink");
      return true;
    }
    boss.hp = Math.max(0, boss.hp - dmg);
    boss.invuln = weapon === this.def.weakness ? 40 : 24;
    this.sfx("bossHit");
    if (weapon === this.def.weakness) {
      this.shake = 8;
      this.addEffect("text", boss.cx, boss.y - 8, { text: "WEAK!", color: "#f8b800" });
    }
    if (boss.hp <= 0) {
      boss.kill();
      this.mode = "bossDead";
      this.modeT = 0;
      this.bullets = [];
      this.enemies = [];
      this.audio.stopMusic();
      this.sfx("death");
      this.burst(boss.cx, boss.y + 12);
      this.warnBeam = -1;
    }
    return true;
  }

  private collide() {
    const p = this.player;
    for (const shot of this.shots) {
      if (shot.dead || shot.deflected) continue;
      for (const e of this.enemies) {
        if (e.dead || shot.hit.has(e) || !overlap(shot, e)) continue;
        if (e.shielded && !SHIELD_PIERCING.includes(shot.kind)) {
          shot.deflected = true;
          shot.vx = -shot.vx * 0.8 || -2;
          shot.vy = -3;
          this.sfx("tink");
          break;
        }
        shot.hit.add(e);
        const killed = this.damageEnemy(e, shot.dmg);
        if (!shot.pierce && !(shot.kind === "jumbo" && killed)) {
          shot.dead = true;
          break;
        }
      }
      if (shot.dead || !this.boss || !this.bossActive()) continue;
      const boss = this.boss;
      if (!boss.visible || shot.hit.has(boss) || !overlap(shot, boss)) continue;
      if (boss.invuln > 0) continue;
      if (this.damageBoss(shot.weapon, shot.charge)) {
        shot.hit.add(boss);
        if (!shot.pierce || shot.kind === "puddle") shot.dead = true;
        if (bossDamage(this.def, shot.weapon, shot.charge) <= 0) {
          shot.deflected = true;
          shot.dead = false;
          shot.vx = -shot.vx || -2;
          shot.vy = -3;
        }
      }
      if (this.mode !== "play") return;
    }
    if (p.state === "dead" || p.invuln > 0) return;
    for (const e of this.enemies) {
      if (!e.dead && overlap(p, e)) {
        p.hurt(this, e.contact);
        return;
      }
    }
    for (const b of this.bullets) {
      if (!b.dead && overlap(p, b) && (b.kind !== "icicle" || b.t > b.a)) {
        p.hurt(this, b.dmg);
        if (!["beam", "crack", "slashwave"].includes(b.kind)) b.dead = true;
        return;
      }
    }
    const boss = this.boss;
    if (boss && boss.visible && boss.state !== "dead" && boss.state !== "teleport" && overlap(p, boss)) p.hurt(this, 4);
  }

  private updateDoor() {
    const doorCol = this.level.doorCol;
    const doorRows = [9, 10, 11];
    const p = this.player;
    const camTo = doorCol * TILE;
    if (this.modeT <= 16) {
      this.doorProgress = this.modeT / 16;
      if (this.modeT === 16) for (const r of doorRows) setTile(this.level, doorCol, r, Tile.Air);
    } else if (this.modeT <= 16 + 80) {
      const t = (this.modeT - 16) / 80;
      this.camX = Math.round(this.doorFrom + (camTo - this.doorFrom) * t);
      p.x = this.doorPlayerFrom + (doorCol * TILE + 22 - this.doorPlayerFrom) * t;
      p.vx = 1;
      p.animT++;
      p.walkFrames = 20;
      p.grounded = true;
    } else if (this.modeT <= 16 + 80 + 16) {
      p.vx = 0;
      this.inBossRoom = true;
      this.doorProgress = 1 - (this.modeT - 96) / 16;
      if (this.modeT === 97) this.sfx("door");
    } else {
      for (const r of doorRows) setTile(this.level, doorCol, r, Tile.Door);
      this.doorProgress = 0;
      this.doorOpening = false;
      this.mode = "bossIntro";
      this.modeT = 0;
      this.boss = new Boss(this.def, this.room().right - 56);
      this.audio.play("boss");
    }
  }

  private updateBossIntro() {
    const boss = this.boss!;
    boss.update(this);
    this.player.vy = Math.min(this.player.vy + 0.25, 7);
    moveBody(this.level, this.player);
    if (boss.state === "pose" && boss.t > 30) {
      if (this.modeT % 2 === 0 && this.bossFill < MAX_HP) {
        this.bossFill++;
        boss.hp = this.bossFill;
        this.sfx("tick");
      }
      if (this.bossFill >= MAX_HP && boss.t > 90) {
        boss.begin();
        this.mode = "play";
        this.modeT = 0;
      }
    }
  }

  /* ---------------- render ---------------- */

  render(ctx: CanvasRenderingContext2D, hud: { lives: number }) {
    const camX = this.camX;
    const sy = this.shakeY;
    // parallax backdrop
    const farX = -Math.floor(camX * 0.25) % BACKDROP_W;
    ctx.drawImage(this.tiles.far, farX, 0);
    ctx.drawImage(this.tiles.far, farX + BACKDROP_W, 0);
    const midX = -Math.floor(camX * 0.5) % BACKDROP_W;
    ctx.drawImage(this.tiles.mid, midX, sy);
    ctx.drawImage(this.tiles.mid, midX + BACKDROP_W, sy);
    this.drawTiles(ctx);

    if (this.warnBeam >= 0 && this.frame % 6 < 3) {
      ctx.fillStyle = "#d82800";
      const room = this.room();
      ctx.fillRect(room.left - camX, this.warnBeam + 4, room.right - room.left, 1);
    }

    for (const item of this.items) {
      if (item.ttl > 0 && item.ttl < 90 && this.frame % 4 < 2) continue;
      const art =
        item.kind === "e" ? PICKLE_CHIP : item.kind === "E" ? PICKLE_BIG : item.kind === "w" ? MUSTARD_SMALL : item.kind === "W" ? MUSTARD_BIG : HEAD_ICON;
      const s = sprite(`item:${item.kind}`, art);
      draw(ctx, s, item.x + item.w / 2 - s.w / 2 - camX, item.y + item.h - s.h + sy);
    }
    for (const e of this.enemies) drawEnemy(ctx, this, e);
    if (this.boss) this.boss.draw(ctx, camX, this.frame, sy);
    if (this.mode === "ready") this.drawBeam(ctx, this.modeT - 56, false);
    else if (this.mode === "exit") this.drawBeam(ctx, this.modeT, true);
    else this.player.draw(ctx, camX, this.frame, sy);
    for (const shot of this.shots) drawShot(ctx, this, shot);
    for (const b of this.bullets) drawBullet(ctx, this, b);
    this.drawEffects(ctx);

    if (this.flash > 0 && this.flash % 4 < 2) {
      ctx.fillStyle = "rgba(252,252,252,0.7)";
      ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    }

    // HUD
    const p = this.player;
    drawBar(ctx, 16, 16, p.hp, "#fce0a8", "#fcfcfc");
    if (p.weapon !== "buster") {
      const w = WEAPONS[p.weapon];
      drawBar(ctx, 26, 16, p.energy[p.weapon], w.primary, "#fcfcfc");
    }
    if (this.boss && (this.mode !== "door")) {
      drawBar(ctx, 40, 16, this.boss.hp, "#f87858", "#fce0a8");
    }
    if (!this.inBossRoom) drawLives(ctx, 12, 77, hud.lives);

    if (this.mode === "ready" && this.modeT < 72 && this.modeT % 16 < 10)
      drawText(ctx, "READY", SCREEN_W / 2, 108, "#fcfcfc", { align: "center", shadow: "#000000" });
  }

  private drawBeam(ctx: CanvasRenderingContext2D, t: number, up: boolean) {
    const p = this.player;
    if (t < 0) return;
    const x = Math.round(p.cx - this.camX);
    const targetY = p.y;
    const beamTop = up ? targetY - t * 10 : Math.min(targetY, -24 + t * 10);
    if (!up && beamTop >= targetY) {
      if (t * 10 - 24 - targetY < 40) {
        // materialise: a squat flicker before the full sprite
        ctx.fillStyle = "#3cbcfc";
        ctx.fillRect(x - 6, p.y + 10, 12, 12);
        ctx.fillStyle = "#fcfcfc";
        ctx.fillRect(x - 3, p.y + 12, 6, 8);
      } else p.draw(ctx, this.camX, this.frame, 0);
      return;
    }
    if (up && t < 8) {
      ctx.fillStyle = "#3cbcfc";
      ctx.fillRect(x - 6, p.y + 6, 12, 16);
      return;
    }
    ctx.fillStyle = "#000000";
    ctx.fillRect(x - 3, beamTop, 6, 22);
    ctx.fillStyle = "#3cbcfc";
    ctx.fillRect(x - 2, beamTop, 4, 22);
    ctx.fillStyle = "#fcfcfc";
    ctx.fillRect(x - 1, beamTop, 2, 22);
  }

  private drawTiles(ctx: CanvasRenderingContext2D) {
    const first = Math.floor(this.camX / TILE);
    const sy = this.shakeY;
    const doorCol = this.level.doorCol;
    for (let col = first; col <= first + 16; col++) {
      for (let row = 0; row < ROWS; row++) {
        const tile = tileAt(this.level, col, row);
        const x = col * TILE - this.camX;
        const y = row * TILE + sy;
        switch (tile) {
          case Tile.Ground: {
            const above = tileAt(this.level, col, row - 1);
            ctx.drawImage(above === Tile.Ground ? this.tiles.fill : this.tiles.top, x, y);
            break;
          }
          case Tile.Block:
            ctx.drawImage(this.tiles.block, x, y);
            break;
          case Tile.Ladder:
            ctx.drawImage(this.tiles.ladder, x, y);
            break;
          case Tile.Spike:
            ctx.drawImage(this.tiles.spike, x, y);
            break;
          case Tile.Door:
            break;
        }
      }
    }
    // the boss shutter, drawn as one piece so it can slide open
    if (doorCol >= first - 1 && doorCol <= first + 16) {
      const x = doorCol * TILE - this.camX;
      const visible = Math.round(48 * (1 - this.doorProgress));
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 9 * TILE + sy, TILE, visible);
      ctx.clip();
      for (let i = 0; i < 3; i++) ctx.drawImage(this.tiles.door, x, (9 + i) * TILE + sy - (48 - visible));
      ctx.restore();
    }
  }

  private drawEffects(ctx: CanvasRenderingContext2D) {
    for (const fx of this.effects) {
      const x = Math.round(fx.x - this.camX);
      const y = Math.round(fx.y + this.shakeY);
      switch (fx.kind) {
        case "explode": {
          const frame = EXPLOSION[Math.min(2, Math.floor(fx.t / 4))];
          draw(ctx, sprite(`ex${Math.min(2, Math.floor(fx.t / 4))}`, frame), x, y);
          break;
        }
        case "orb":
          draw(ctx, Math.floor(fx.t / 4) % 2 ? sprite("orbA", ORB_A) : sprite("orbB", ORB_B), x, y);
          break;
        case "spark":
          ctx.fillStyle = fx.t % 2 ? "#fcfcfc" : "#f8b800";
          ctx.fillRect(x - 4, y - 1, 8, 2);
          ctx.fillRect(x - 1, y - 4, 2, 8);
          break;
        case "dust":
          ctx.fillStyle = fx.t < 6 ? "#fcfcfc" : "#bcbcbc";
          ctx.fillRect(x - 4 - fx.t / 2, y - 3, 3, 3);
          ctx.fillRect(x + 1 + fx.t / 2, y - 3, 3, 3);
          break;
        case "text":
          if (fx.t % 4 < 3) drawText(ctx, fx.text ?? "", x, y, fx.color ?? "#fcfcfc", { align: "center", shadow: "#000000" });
          break;
        case "charge":
          break;
      }
    }
  }
}
