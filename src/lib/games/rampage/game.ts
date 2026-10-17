// DELI RAMPAGE: ONE STAR MONSTER — a Rampage-style arcade game for the Corner Arcade.
// The customers who complained are yelling out of their windows; you're sixty feet
// tall and out of patience. Punch the walls, hand subs to the complainers, swat the
// news copter, and bring every building on the block down.
//
// Fixed 60 Hz simulation, 320x180 canvas, drawn with plain rectangles and the Deli Man
// pixel font. Nothing here touches the DOM except render() and the leaderboard calls,
// so the simulation runs in node tests.
import { DeliManAudio } from "../deli-man/audio";
import { drawText, textWidth, wrap } from "../deli-man/font";
import { Input } from "../deli-man/input";
import { PERFECT_ORDER_COMPLAINTS } from "../complaints";
import {
  BUILDING_NAMES,
  COLLAPSE_LINES,
  COMPLAINTS,
  INSPECTOR_LINES,
  MANAGER_LINES,
  MONSTERS,
  NEWS_LINES,
  SERVED_LINES,
  STREETS,
  type Monster,
} from "./data";

export const SCREEN_W = 320;
export const SCREEN_H = 180;
export const STEP_MS = 1000 / 60;
export const GAME_ID = "deli-rampage";

const GROUND = 160;
const CELL_W = 16;
const CELL_H = 14;
const CELL_HP = 2;
const PW = 9; // half the monster's width
const PH = 34; // the monster's height
const GRAVITY = 0.22;
const START_LIVES = 3;
/** A building comes down once this share of its wall is holes. */
const COLLAPSE_SHARE = 0.5;

type Occupant = {
  kind: "complainer" | "manager" | "food" | "pepper";
  life: number;
  age: number;
  line: string;
  throwT: number;
  hair: string;
  skin: string;
};
type Cell = { hp: number; hole: boolean; occupant: Occupant | null };
export type Building = {
  x: number;
  w: number;
  floors: number;
  cols: number;
  roof: number;
  cells: Cell[][];
  color: string;
  trim: string;
  name: string;
  collapsing: boolean;
  gone: boolean;
  sink: number;
};
type Mode = "stand" | "air" | "climb" | "dead";
type Player = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  mode: Mode;
  on: Building | null;
  climbB: Building | null;
  punchT: number;
  punchDir: "side" | "up" | "down";
  punchHit: boolean;
  invuln: number;
  patience: number;
  walkT: number;
  deadT: number;
};
type Projectile = { x: number; y: number; vx: number; vy: number; g: number; kind: "star" | "cup" | "phone" | "ticket"; spin: number; dead: boolean };
type Inspector = { x: number; vx: number; throwT: number; hp: number; flying: boolean; fx: number; fy: number; fvx: number; fvy: number; line: string; lineT: number };
type Copter = { x: number; y: number; vx: number; hp: number; fireT: number; falling: boolean; vy: number; t: number; hurtT: number };
type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string; size: number; g: number };
type Floater = { x: number; y: number; text: string; color: string; t: number };
type Bubble = { x: number; y: number; text: string; t: number };
export type Score = { player_name: string; score: number };
type State = "title" | "intro" | "play" | "pause" | "clear" | "gameover" | "entry" | "scores";

const SKY = ["#1c1442", "#3a1f5c", "#7a3268", "#d0605a", "#f0a060"];
const WALLS = [
  ["#8a4b3a", "#5e3024"],
  ["#5f6f86", "#3d4a5c"],
  ["#9a8a5a", "#6a5c38"],
  ["#6a8a5a", "#466238"],
  ["#8a5a7a", "#5e3a52"],
  ["#a0705a", "#704a38"],
];
const SKINS = ["#f0c090", "#d89060", "#a86838", "#7a4a28", "#f8d0b0"];
const HAIRS = ["#3a2010", "#f0d050", "#9a3010", "#202020", "#c0c0c0", "#b050d0"];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Game {
  readonly input = new Input();
  readonly audio = new DeliManAudio();
  state: State = "title";
  monsterIndex = 0;
  level = 1;
  score = 0;
  lives = START_LIVES;
  buildings: Building[] = [];
  player: Player = this.freshPlayer();
  projectiles: Projectile[] = [];
  inspectors: Inspector[] = [];
  copters: Copter[] = [];
  particles: Particle[] = [];
  floaters: Floater[] = [];
  bubbles: Bubble[] = [];
  scores: Score[] = [];
  scoresLoaded = false;
  initials = ["A", "A", "A"];
  initialIndex = 0;
  submitted: "idle" | "sending" | "sent" | "failed" = "idle";
  stateT = 0;
  frame = 0;
  shake = 0;
  spawnT = 0;
  inspectorT = 0;
  copterT = 0;
  clearPost = "";
  clearBonus = 0;
  private rand: () => number;

  constructor(seed = Date.now()) {
    this.rand = mulberry32(seed);
  }

  get monster(): Monster {
    return MONSTERS[this.monsterIndex];
  }

  // ---------------------------------------------------------------- flow

  private pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)];
  }

  private setState(state: State) {
    this.state = state;
    this.stateT = 0;
    if (state === "title") this.audio.play("title");
    if (state === "intro" || state === "play") this.audio.play(this.level % 2 ? "stage2" : "stage3");
    if (state === "clear") this.audio.play("victory");
    if (state === "gameover") this.audio.stopMusic();
  }

  startGame(monsterIndex = this.monsterIndex) {
    this.monsterIndex = monsterIndex;
    this.level = 1;
    this.score = 0;
    this.lives = START_LIVES;
    this.submitted = "idle";
    this.initials = ["A", "A", "A"];
    this.initialIndex = 0;
    this.startLevel();
  }

  private startLevel() {
    this.buildings = this.makeBlock(this.level);
    this.player = this.freshPlayer();
    this.projectiles = [];
    this.inspectors = [];
    this.copters = [];
    this.particles = [];
    this.floaters = [];
    this.bubbles = [];
    this.spawnT = 60;
    this.inspectorT = 400;
    this.copterT = 700;
    this.setState("intro");
  }

  private freshPlayer(): Player {
    return {
      x: 14, y: GROUND, vx: 0, vy: 0, facing: 1, mode: "stand", on: null, climbB: null,
      punchT: 0, punchDir: "side", punchHit: false, invuln: 90,
      patience: this.monster?.patience ?? 100, walkT: 0, deadT: 0,
    };
  }

  get streetName() {
    return STREETS[(this.level - 1) % STREETS.length];
  }

  makeBlock(level: number): Building[] {
    const count = level <= 2 ? 3 : 4;
    const cols = count === 3 ? 4 : 3;
    const w = cols * CELL_W;
    const gap = (SCREEN_W - 36 - count * w) / (count - 1);
    const names = [...BUILDING_NAMES].sort(() => this.rand() - 0.5);
    return Array.from({ length: count }, (_, i) => {
      const floors = Math.min(8, 4 + Math.floor(this.rand() * (3 + Math.min(level, 3))));
      const [color, trim] = this.pick(WALLS);
      return {
        x: Math.round(18 + i * (w + gap)), w, floors, cols, roof: GROUND - floors * CELL_H,
        cells: Array.from({ length: floors }, () => Array.from({ length: cols }, () => ({ hp: CELL_HP, hole: false, occupant: null }))),
        color, trim, name: names[i % names.length], collapsing: false, gone: false, sink: 0,
      };
    });
  }

  pauseIfPlaying() {
    if (this.state === "play") this.setState("pause");
  }

  /** A tap on the screen: starts the game from the menus. */
  tap(x: number, _y: number) {
    this.audio.unlock();
    if (this.state === "title") {
      if (x < SCREEN_W * 0.3) this.cycleMonster(-1);
      else if (x > SCREEN_W * 0.7) this.cycleMonster(1);
      else this.startGame();
    } else if (this.state === "scores") this.setState("title");
    else if (this.state === "pause") this.setState("play");
  }

  private cycleMonster(step: number) {
    this.monsterIndex = (this.monsterIndex + step + MONSTERS.length) % MONSTERS.length;
    this.audio.sfx("move");
  }

  // ---------------------------------------------------------------- update

  update() {
    this.input.poll();
    this.frame++;
    this.stateT++;
    if (this.shake > 0) this.shake--;
    const go = this.input.pressed("start") || this.input.pressed("jump") || this.input.pressed("shoot");
    switch (this.state) {
      case "title":
        if (this.stateT === 1 && !this.scoresLoaded) void this.loadScores();
        if (this.input.pressed("left")) this.cycleMonster(-1);
        if (this.input.pressed("right")) this.cycleMonster(1);
        if (go) {
          this.audio.sfx("ready");
          this.startGame();
        }
        break;
      case "intro":
        this.updateEffects();
        if (this.stateT > 130 || (this.stateT > 30 && go)) this.setState("play");
        break;
      case "play":
        if (this.input.pressed("start")) {
          this.setState("pause");
          this.audio.sfx("pause");
          break;
        }
        this.updatePlay();
        break;
      case "pause":
        if (this.input.pressed("start")) {
          this.setState("play");
          this.audio.sfx("pause");
        }
        break;
      case "clear":
        this.updateEffects();
        if (this.stateT > 300 || (this.stateT > 60 && go)) {
          this.level++;
          const keep = this.player.patience;
          this.startLevel();
          this.player.patience = Math.min(this.monster.patience, keep + 40);
        }
        break;
      case "gameover":
        this.updateEffects();
        if (this.stateT > 150 || (this.stateT > 50 && go)) this.setState(this.score > 0 ? "entry" : "scores");
        break;
      case "entry":
        this.updateEntry();
        break;
      case "scores":
        if (this.stateT > 30 && go) this.setState("title");
        break;
    }
  }

  private updateEntry() {
    const letter = this.initials[this.initialIndex].charCodeAt(0) - 65;
    if (this.input.pressed("up")) this.initials[this.initialIndex] = String.fromCharCode(65 + ((letter + 1) % 26));
    if (this.input.pressed("down")) this.initials[this.initialIndex] = String.fromCharCode(65 + ((letter + 25) % 26));
    if (this.input.pressed("left") && this.initialIndex > 0) this.initialIndex--;
    if (this.input.pressed("up") || this.input.pressed("down")) this.audio.sfx("move");
    if (this.input.pressed("right") || this.input.pressed("jump") || this.input.pressed("shoot") || this.input.pressed("start")) {
      this.audio.sfx("select");
      if (this.initialIndex < 2) this.initialIndex++;
      else {
        void this.submitScore();
        this.setState("scores");
      }
    }
  }

  private updatePlay() {
    const L = this.level;
    this.updatePlayer();
    this.updateBuildings();

    // Customers show up in the windows.
    if (--this.spawnT <= 0) {
      this.spawnT = Math.max(38, 105 - L * 9) + Math.floor(this.rand() * 40);
      this.spawnOccupant();
    }
    if (--this.inspectorT <= 0) {
      this.inspectorT = Math.max(360, 900 - L * 80);
      if (this.inspectors.filter((i) => !i.flying).length < (L >= 4 ? 2 : 1)) {
        const fromLeft = this.player.x > SCREEN_W / 2;
        this.inspectors.push({ x: fromLeft ? -10 : SCREEN_W + 10, vx: fromLeft ? 0.45 : -0.45, throwT: 90, hp: 1, flying: false, fx: 0, fy: 0, fvx: 0, fvy: 0, line: this.pick(INSPECTOR_LINES), lineT: 90 });
      }
    }
    if (L >= 2 && --this.copterT <= 0) {
      this.copterT = Math.max(500, 1100 - L * 70);
      if (this.copters.filter((c) => !c.falling).length < (L >= 5 ? 2 : 1)) {
        const fromLeft = this.rand() < 0.5;
        this.copters.push({ x: fromLeft ? -20 : SCREEN_W + 20, y: 30, vx: 0, hp: 2, fireT: 120, falling: false, vy: 0, t: 0, hurtT: 0 });
        this.float(SCREEN_W / 2, 30, this.pick(NEWS_LINES), "#f8f878");
      }
    }
    this.updateOccupants();
    this.updateInspectors();
    this.updateCopters();
    this.updateProjectiles();
    this.updateEffects();

    if (this.buildings.every((b) => b.gone) && this.player.mode !== "dead") {
      this.clearBonus = Math.round(this.player.patience) * 10 + L * 500;
      this.score += this.clearBonus;
      this.clearPost = this.pick(PERFECT_ORDER_COMPLAINTS);
      this.setState("clear");
    }
  }

  private roofOf(b: Building) {
    return b.roof + b.sink;
  }

  private solid() {
    return this.buildings.filter((b) => !b.collapsing && !b.gone);
  }

  private updatePlayer() {
    const p = this.player;
    const m = this.monster;
    if (p.invuln > 0) p.invuln--;
    if (p.mode === "dead") {
      p.deadT++;
      p.vy = Math.min(5, p.vy + GRAVITY);
      p.y = Math.min(GROUND, p.y + p.vy);
      if (p.deadT > 150) {
        this.lives--;
        if (this.lives <= 0) {
          this.setState("gameover");
          this.audio.sfx("death");
        } else {
          this.player = this.freshPlayer();
          this.player.invuln = 150;
          this.player.x = p.x < SCREEN_W / 2 ? SCREEN_W - 14 : 14;
          this.player.facing = this.player.x > SCREEN_W / 2 ? -1 : 1;
          this.float(this.player.x, GROUND - 46, "BREAK'S OVER", "#f8f878");
        }
      }
      return;
    }
    const dirX = (this.input.held("right") ? 1 : 0) - (this.input.held("left") ? 1 : 0);
    const up = this.input.held("up");
    const down = this.input.held("down");

    if (p.punchT > 0) p.punchT--;
    if (this.input.pressed("shoot") && p.punchT === 0) {
      p.punchT = 14;
      p.punchHit = false;
      p.punchDir = up ? "up" : down && p.mode === "stand" && p.on ? "down" : "side";
      this.audio.sfx("shoot");
    }

    if (p.mode === "climb") {
      const b = p.climbB!;
      if (b.collapsing || b.gone) {
        p.mode = "air";
        p.climbB = null;
      } else {
        const side = p.x < b.x + b.w / 2 ? "left" : "right";
        p.facing = side === "left" ? 1 : -1;
        p.x = side === "left" ? b.x - PW : b.x + b.w + PW;
        if (up) p.y -= m.climb;
        if (down) p.y += m.climb;
        if (up || down) p.walkT++;
        const roof = this.roofOf(b);
        if (p.y >= GROUND) {
          p.y = GROUND;
          if (down) {
            p.mode = "stand";
            p.on = null;
            p.climbB = null;
          }
        }
        if (p.y <= roof + 1) {
          p.y = roof;
          if (up) {
            p.x += p.facing * (PW + 3);
            p.mode = "stand";
            p.on = b;
            p.climbB = null;
          }
        }
        if (p.mode === "climb" && this.input.pressed("jump")) {
          p.mode = "air";
          p.vy = -3.2;
          p.vx = -p.facing * 1.6;
          p.facing = (-p.facing) as 1 | -1;
          p.climbB = null;
        } else if (p.mode === "climb" && dirX === -p.facing && !up && !down) {
          p.mode = "air";
          p.vy = 0;
          p.vx = dirX * m.speed;
          p.facing = dirX as 1 | -1;
          p.climbB = null;
        }
      }
    } else {
      if (p.punchT === 0 || p.mode === "air") p.vx = dirX * m.speed * (p.punchT > 0 ? 0.4 : 1);
      else p.vx = 0;
      if (dirX) p.facing = dirX as 1 | -1;
      if (dirX && p.mode === "stand") p.walkT++;
      if (p.mode === "stand" && this.input.pressed("jump")) {
        p.mode = "air";
        p.vy = -4.6;
        p.on = null;
        this.audio.sfx("move");
      }
      // Standing on a roof that just started to come down: fall with it.
      if (p.mode === "stand" && p.on && (p.on.collapsing || p.on.gone)) {
        p.mode = "air";
        p.on = null;
      }

      // Horizontal move; walking into a wall starts a climb.
      let nx = p.x + p.vx;
      let wall: Building | null = null;
      for (const b of this.solid()) {
        if (p.y <= this.roofOf(b) + 3) continue;
        if (p.x <= b.x - PW + 0.01 && nx > b.x - PW) {
          nx = b.x - PW;
          wall = b;
        } else if (p.x >= b.x + b.w + PW - 0.01 && nx < b.x + b.w + PW) {
          nx = b.x + b.w + PW;
          wall = b;
        }
      }
      p.x = Math.max(PW, Math.min(SCREEN_W - PW, nx));
      if (wall && dirX !== 0) {
        p.mode = "climb";
        p.climbB = wall;
        p.on = null;
        p.vy = 0;
      }

      if (p.mode === "stand" && p.on) {
        const b = p.on;
        p.y = this.roofOf(b);
        if (p.x < b.x - PW + 1 || p.x > b.x + b.w + PW - 1) {
          p.mode = "air";
          p.on = null;
          p.vy = 0;
        }
      }
      if (p.mode === "air") {
        const before = p.y;
        p.vy = Math.min(5, p.vy + GRAVITY);
        p.y += p.vy;
        if (p.vy > 0) {
          for (const b of this.solid()) {
            const roof = this.roofOf(b);
            if (before <= roof && p.y >= roof && p.x >= b.x - PW + 1 && p.x <= b.x + b.w + PW - 1) {
              p.y = roof;
              p.mode = "stand";
              p.on = b;
              this.audio.sfx("land");
              break;
            }
          }
        }
        if (p.mode === "air" && p.y >= GROUND) {
          p.y = GROUND;
          p.mode = "stand";
          p.on = null;
          this.audio.sfx("land");
        }
      }
    }

    // The punch lands on frame 4 of 14.
    if (p.punchT === 10 && !p.punchHit) this.resolvePunch();
  }

  /** Where the fist is this punch, in screen coordinates. */
  fist() {
    const p = this.player;
    if (p.punchDir === "up") return { x: p.x + p.facing * 6, y: p.y - PH - 8 };
    if (p.punchDir === "down" && p.on) return { x: p.x, y: this.roofOf(p.on) + 5 };
    if (p.mode === "climb" && p.climbB) {
      const b = p.climbB;
      return { x: p.facing > 0 ? b.x + 4 : b.x + b.w - 4, y: p.y - 20 };
    }
    return { x: p.x + p.facing * 17, y: p.y - 20 };
  }

  private resolvePunch() {
    const p = this.player;
    p.punchHit = true;
    const f = this.fist();
    const near = (x: number, y: number, r: number) => Math.abs(x - f.x) <= r && Math.abs(y - f.y) <= r + 2;

    for (const shot of this.projectiles) {
      if (!shot.dead && near(shot.x, shot.y, 9)) {
        shot.dead = true;
        this.score += 50;
        this.float(shot.x, shot.y, "SWAT! +50", "#f8f8f8");
        this.burst(shot.x, shot.y, "#f8f8f8", 5);
        this.audio.sfx("tink");
        return;
      }
    }
    for (const c of this.copters) {
      if (!c.falling && near(c.x, c.y, 14)) {
        c.hp--;
        c.hurtT = 12;
        this.audio.sfx("bossHit");
        this.burst(f.x, f.y, "#f8f878", 6);
        if (c.hp <= 0) {
          c.falling = true;
          c.vy = -1;
          this.score += 700;
          this.float(c.x, c.y - 10, "NO COMMENT! +700", "#f8f878");
        }
        return;
      }
    }
    for (const i of this.inspectors) {
      if (!i.flying && near(i.x, GROUND - 9, 11)) {
        i.flying = true;
        i.fx = i.x;
        i.fy = GROUND - 10;
        i.fvx = p.facing * 2.4;
        i.fvy = -3.4;
        this.score += 300;
        this.float(i.x, GROUND - 30, "I'LL BE BACK W/ A FORM +300", "#a4e4fc");
        this.audio.sfx("enemyDie");
        return;
      }
    }
    // The wall.
    for (const b of this.solid()) {
      const roof = this.roofOf(b);
      if (f.x < b.x || f.x >= b.x + b.w || f.y < roof || f.y >= GROUND) continue;
      const col = Math.floor((f.x - b.x) / CELL_W);
      const row = Math.floor((f.y - roof) / CELL_H);
      this.hitCell(b, row, col);
      return;
    }
    this.audio.sfx("move");
  }

  hitCell(b: Building, row: number, col: number) {
    const cell = b.cells[row]?.[col];
    if (!cell) return;
    const cx = b.x + col * CELL_W + CELL_W / 2;
    const cy = this.roofOf(b) + row * CELL_H + CELL_H / 2;
    const o = cell.occupant;
    if (o) {
      cell.occupant = null;
      if (o.kind === "complainer" || o.kind === "manager") {
        const points = o.kind === "manager" ? 900 : 500;
        this.score += points;
        this.float(cx, cy - 8, `${this.pick(SERVED_LINES)} +${points}`, "#f8f878");
        for (let i = 0; i < 5; i++) this.particles.push({ x: cx, y: cy, vx: (i - 2) * 0.5, vy: -1.4 - this.rand(), life: 50, color: "#f8d838", size: 2, g: 0.02 });
        this.audio.sfx("pickup");
      } else if (o.kind === "food") {
        this.player.patience = Math.min(this.monster.patience, this.player.patience + 25);
        this.score += 100;
        this.float(cx, cy - 8, "FREE SUB! +PATIENCE", "#78f878");
        this.audio.sfx("oneUp");
      } else {
        this.hurt(12, "SPICY!!");
      }
      return;
    }
    if (cell.hole) {
      this.audio.sfx("move");
      return;
    }
    cell.hp -= this.monster.punch;
    this.shake = Math.max(this.shake, 3);
    if (cell.hp <= 0) {
      cell.hole = true;
      this.score += 50;
      this.burst(cx, cy, b.color, 9);
      this.burst(cx, cy, "#a4e4fc", 4);
      this.audio.sfx("thud");
      const holes = b.cells.flat().filter((c) => c.hole).length;
      if (holes >= Math.ceil(b.cols * b.floors * COLLAPSE_SHARE)) this.collapse(b);
    } else {
      this.score += 10;
      this.burst(cx, cy, b.color, 4);
      this.audio.sfx("hit");
    }
  }

  private collapse(b: Building) {
    b.collapsing = true;
    for (const row of b.cells) for (const c of row) c.occupant = null;
    this.score += 1000 + b.floors * 100;
    this.shake = 40;
    this.float(b.x + b.w / 2, b.roof - 14, `${this.pick(COLLAPSE_LINES)} +${1000 + b.floors * 100}`, "#f87858");
    if (this.rand() < 0.5) this.float(b.x + b.w / 2, b.roof - 4, "(EVERYONE GOT OUT FINE)", "#bcbcbc");
    this.audio.sfx("explode");
    this.bubbles = this.bubbles.filter((bubble) => bubble.x < b.x || bubble.x > b.x + b.w);
    const p = this.player;
    if (p.climbB === b || p.on === b) {
      p.mode = "air";
      p.climbB = null;
      p.on = null;
    }
  }

  private updateBuildings() {
    for (const b of this.buildings) {
      if (!b.collapsing || b.gone) continue;
      b.sink += 0.7;
      if (this.frame % 2 === 0) {
        for (let i = 0; i < 3; i++)
          this.particles.push({ x: b.x + this.rand() * b.w, y: GROUND - 2, vx: (this.rand() - 0.5) * 1.6, vy: -this.rand() * 1.4, life: 40, color: this.rand() < 0.5 ? "#a09080" : "#c8b8a8", size: 3, g: -0.005 });
      }
      if (this.frame % 20 === 0) this.audio.sfx("thud");
      if (b.sink >= GROUND - b.roof) b.gone = true;
    }
  }

  private spawnOccupant() {
    const L = this.level;
    const live = this.buildings.flatMap((b) => b.cells.flat()).filter((c) => c.occupant).length;
    if (live >= 3 + L) return;
    const choices: Array<{ b: Building; r: number; c: number }> = [];
    for (const b of this.solid())
      b.cells.forEach((row, r) => row.forEach((cell, c) => { if (!cell.hole && !cell.occupant) choices.push({ b, r, c }); }));
    if (!choices.length) return;
    const spot = this.pick(choices);
    const roll = this.rand();
    const kind = roll < 0.12 ? "food" : roll < 0.2 ? "pepper" : L >= 2 && roll < 0.32 ? "manager" : "complainer";
    const line = kind === "manager" ? this.pick(MANAGER_LINES) : kind === "complainer" ? this.pick(COMPLAINTS) : "";
    spot.b.cells[spot.r][spot.c].occupant = {
      kind, line, age: 0, life: kind === "food" || kind === "pepper" ? 320 : 460,
      throwT: 70 + Math.floor(this.rand() * 60), hair: this.pick(HAIRS), skin: this.pick(SKINS),
    };
  }

  private updateOccupants() {
    const L = this.level;
    const p = this.player;
    for (const b of this.solid()) {
      b.cells.forEach((row, r) => row.forEach((cell, c) => {
        const o = cell.occupant;
        if (!o) return;
        o.age++;
        if (o.age >= o.life) {
          cell.occupant = null;
          return;
        }
        const cx = b.x + c * CELL_W + CELL_W / 2;
        const cy = this.roofOf(b) + r * CELL_H + CELL_H / 2;
        if ((o.kind === "complainer" || o.kind === "manager") && o.age === 8) this.bubbles.push({ x: cx, y: cy - 10, text: o.line, t: 150 });
        if (o.kind !== "complainer" && o.kind !== "manager") return;
        if (--o.throwT > 0) return;
        o.throwT = Math.max(60, (o.kind === "manager" ? 100 : 150) - L * 8) + Math.floor(this.rand() * 40);
        const dx = p.x - cx;
        const dy = p.y - 20 - cy;
        if (Math.hypot(dx, dy) > 170 || p.mode === "dead") return;
        const speed = 1.3 + L * 0.13;
        const kind = this.pick(["star", "cup", "phone"] as const);
        const d = Math.max(1, Math.hypot(dx, dy));
        if (kind === "cup") this.projectiles.push({ x: cx, y: cy, vx: dx / 60, vy: dy / 60 - 1.8, g: 0.06, kind, spin: 0, dead: false });
        else this.projectiles.push({ x: cx, y: cy, vx: (dx / d) * speed, vy: (dy / d) * speed, g: 0, kind, spin: 0, dead: false });
      }));
    }
  }

  private updateInspectors() {
    const p = this.player;
    for (const i of this.inspectors) {
      if (i.flying) {
        i.fx += i.fvx;
        i.fy += i.fvy;
        i.fvy += 0.15;
        continue;
      }
      if (i.lineT > 0) i.lineT--;
      const dist = p.x - i.x;
      if (Math.abs(dist) > 60) i.x += Math.sign(dist) * Math.abs(i.vx);
      if (--i.throwT <= 0 && p.mode !== "dead") {
        i.throwT = 110;
        i.line = this.pick(INSPECTOR_LINES);
        i.lineT = 70;
        this.projectiles.push({ x: i.x, y: GROUND - 18, vx: Math.sign(dist || 1) * 1.6, vy: -2.6 + Math.max(-1.5, (p.y - GROUND) / 40), g: 0.07, kind: "ticket", spin: 0, dead: false });
      }
      if (Math.abs(dist) < PW + 4 && p.y > GROUND - 12) this.hurt(5);
    }
    this.inspectors = this.inspectors.filter((i) => !i.flying || i.fy < SCREEN_H + 20);
  }

  private updateCopters() {
    const p = this.player;
    for (const c of this.copters) {
      c.t++;
      if (c.hurtT > 0) c.hurtT--;
      if (c.falling) {
        c.vy += 0.12;
        c.y += c.vy;
        c.x += c.vx;
        if (this.frame % 3 === 0) this.particles.push({ x: c.x, y: c.y, vx: 0, vy: -0.4, life: 30, color: "#606060", size: 3, g: -0.01 });
        if (c.y >= GROUND - 4) {
          c.hp = -99;
          this.burst(c.x, GROUND - 6, "#f87818", 16);
          this.burst(c.x, GROUND - 6, "#f8f878", 10);
          this.shake = 16;
          this.audio.sfx("explode");
        }
        continue;
      }
      const target = Math.max(20, Math.min(SCREEN_W - 20, p.x - p.facing * 30));
      c.vx += Math.sign(target - c.x) * 0.03;
      c.vx = Math.max(-1.1, Math.min(1.1, c.vx)) * 0.985;
      c.x += c.vx;
      c.y = 30 + Math.sin(c.t / 30) * 8;
      if (--c.fireT <= 0 && p.mode !== "dead") {
        c.fireT = Math.max(70, 140 - this.level * 8);
        const dx = p.x - c.x;
        const dy = p.y - 20 - c.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        this.projectiles.push({ x: c.x, y: c.y + 6, vx: (dx / d) * 2, vy: (dy / d) * 2, g: 0, kind: "star", spin: 0, dead: false });
      }
    }
    this.copters = this.copters.filter((c) => c.hp > -99);
  }

  private updateProjectiles() {
    const p = this.player;
    for (const s of this.projectiles) {
      s.x += s.vx;
      s.y += s.vy;
      s.vy += s.g;
      s.spin++;
      if (s.x < -10 || s.x > SCREEN_W + 10 || s.y > GROUND + 4 || s.y < -20) s.dead = true;
      if (!s.dead && p.mode !== "dead" && Math.abs(s.x - p.x) < PW + 2 && s.y > p.y - PH && s.y < p.y) {
        s.dead = true;
        this.hurt(s.kind === "ticket" ? 5 : s.kind === "cup" ? 7 : 6, s.kind === "ticket" ? "FINED!" : s.kind === "star" ? "1 STAR!" : undefined);
      }
    }
    this.projectiles = this.projectiles.filter((s) => !s.dead);
  }

  hurt(amount: number, label?: string) {
    const p = this.player;
    if (p.mode === "dead" || p.invuln > 0) return;
    p.patience = Math.max(0, p.patience - amount);
    p.invuln = 50;
    this.audio.sfx("hurt");
    this.float(p.x, p.y - PH - 8, label ? `${label} -${amount}` : `-${amount}`, "#f87858");
    if (p.patience <= 0) {
      p.mode = "dead";
      p.deadT = 0;
      p.vy = 0;
      p.climbB = null;
      p.on = null;
      this.float(p.x, p.y - PH - 18, this.monster.breakLine, "#f8f8f8");
      this.audio.sfx("death");
    }
  }

  private updateEffects() {
    for (const q of this.particles) {
      q.x += q.vx;
      q.y += q.vy;
      q.vy += q.g || 0.12;
      q.life--;
    }
    this.particles = this.particles.filter((q) => q.life > 0);
    for (const f of this.floaters) {
      f.t++;
      f.y -= 0.35;
    }
    this.floaters = this.floaters.filter((f) => f.t < 90);
    for (const b of this.bubbles) b.t--;
    this.bubbles = this.bubbles.filter((b) => b.t > 0);
  }

  private float(x: number, y: number, text: string, color: string) {
    // Stack new pop-ups above recent ones instead of on top of them.
    while (this.floaters.some((f) => f.t < 40 && Math.abs(f.y - y) < 9 && Math.abs(f.x - x) < (textWidth(f.text) + textWidth(text)) / 2)) y -= 9;
    this.floaters.push({ x, y: Math.max(14, y), text, color, t: 0 });
  }

  private burst(x: number, y: number, color: string, n: number) {
    for (let i = 0; i < n; i++)
      this.particles.push({ x, y, vx: (this.rand() - 0.5) * 3.2, vy: -this.rand() * 3, life: 30 + Math.floor(this.rand() * 20), color, size: this.rand() < 0.3 ? 3 : 2, g: 0.15 });
  }

  // ---------------------------------------------------------------- leaderboard

  async loadScores() {
    this.scoresLoaded = true;
    if (typeof fetch === "undefined" || typeof window === "undefined") return;
    try {
      const response = await fetch(`/api/games/leaderboard?gameId=${GAME_ID}&limit=8`, { cache: "no-store" });
      const data = (await response.json()) as { success?: boolean; scores?: Score[] };
      if (data.success && data.scores) this.scores = data.scores;
    } catch {
      /* offline: keep what we have */
    }
  }

  async submitScore() {
    if (this.submitted !== "idle" || this.score <= 0) return;
    this.submitted = "sending";
    const entry = { player_name: this.initials.join(""), score: this.score };
    this.scores = [...this.scores, entry].sort((a, b) => b.score - a.score).slice(0, 8);
    if (typeof fetch === "undefined" || typeof window === "undefined") return;
    try {
      const response = await fetch("/api/games/leaderboard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: GAME_ID, playerName: entry.player_name, score: this.score, metadata: { level: this.level, monster: this.monster.id } }),
      });
      this.submitted = response.ok ? "sent" : "failed";
      if (response.ok) await this.loadScores();
    } catch {
      this.submitted = "failed";
    }
  }

  // ---------------------------------------------------------------- render

  render(ctx: CanvasRenderingContext2D) {
    ctx.imageSmoothingEnabled = false;
    if (this.state === "title") return this.drawTitle(ctx);
    if (this.state === "entry") return this.drawEntry(ctx);
    if (this.state === "scores") return this.drawScores(ctx);
    ctx.save();
    if (this.shake > 0) ctx.translate(Math.round((this.rand() - 0.5) * Math.min(6, this.shake / 2)), Math.round((this.rand() - 0.5) * Math.min(4, this.shake / 3)));
    this.drawBackdrop(ctx);
    for (const b of this.buildings) this.drawBuilding(ctx, b);
    for (const i of this.inspectors) this.drawInspector(ctx, i);
    for (const c of this.copters) this.drawCopter(ctx, c);
    this.drawPlayer(ctx);
    for (const s of this.projectiles) this.drawProjectile(ctx, s);
    for (const q of this.particles) {
      ctx.fillStyle = q.color;
      ctx.fillRect(Math.round(q.x), Math.round(q.y), q.size, q.size);
    }
    this.drawBubbles(ctx);
    for (const f of this.floaters) {
      if (f.t > 70 && f.t % 4 < 2) continue;
      drawText(ctx, f.text, Math.max(textWidth(f.text) / 2 + 2, Math.min(SCREEN_W - textWidth(f.text) / 2 - 2, f.x)), f.y, f.color, { align: "center", shadow: "#000" });
    }
    ctx.restore();
    this.drawHud(ctx);
    if (this.state === "intro") this.drawIntro(ctx);
    if (this.state === "pause") this.panel(ctx, ["PAUSED", "", "PRESS START"], 60);
    if (this.state === "clear") this.drawClear(ctx);
    if (this.state === "gameover") this.panel(ctx, ["GAME OVER", "", "THE CUSTOMERS WIN.", "THEY ALWAYS DO."], 50);
  }

  private drawBackdrop(ctx: CanvasRenderingContext2D) {
    const band = GROUND / SKY.length;
    SKY.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, Math.floor(i * band), SCREEN_W, Math.ceil(band) + 1);
    });
    // Setting sun and the river with the bridge to Canada.
    ctx.fillStyle = "#f8d070";
    ctx.fillRect(236, 96, 26, 4);
    ctx.fillRect(232, 100, 34, 10);
    ctx.fillStyle = "#284878";
    ctx.fillRect(0, 110, SCREEN_W, 50);
    ctx.fillStyle = "#3a5c90";
    for (let x = (this.frame >> 3) % 12; x < SCREEN_W; x += 12) ctx.fillRect(x, 118 + ((x >> 3) % 3) * 9, 6, 1);
    ctx.fillStyle = "#1c1a34";
    ctx.fillRect(0, 98, SCREEN_W, 3);
    for (const tower of [70, 200]) {
      ctx.fillRect(tower, 74, 4, 36);
      ctx.fillRect(tower + 10, 74, 4, 36);
      ctx.fillRect(tower, 74, 14, 3);
    }
    ctx.fillStyle = "#2a2848";
    for (let x = 0; x < SCREEN_W; x += 2) {
      const sag = (x: number, a: number, b: number) => 76 + 20 * Math.pow((x - (a + b) / 2) / ((b - a) / 2), 2);
      const y = x < 70 ? 96 - (x / 70) * 20 : x < 214 ? Math.min(98, sag(x, 72, 212)) : 76 + ((x - 214) / 106) * 20;
      ctx.fillRect(x, Math.round(y), 2, 1);
    }
    // Sidewalk and street.
    ctx.fillStyle = "#8a8a8a";
    ctx.fillRect(0, GROUND, SCREEN_W, 4);
    ctx.fillStyle = "#6a6a6a";
    for (let x = 0; x < SCREEN_W; x += 16) ctx.fillRect(x, GROUND, 1, 4);
    ctx.fillStyle = "#2c2c30";
    ctx.fillRect(0, GROUND + 4, SCREEN_W, SCREEN_H - GROUND - 4);
    ctx.fillStyle = "#e8c838";
    for (let x = 4; x < SCREEN_W; x += 24) ctx.fillRect(x, GROUND + 11, 12, 2);
  }

  private drawBuilding(ctx: CanvasRenderingContext2D, b: Building) {
    if (b.gone) return;
    const roof = this.roofOf(b);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, SCREEN_W, GROUND);
    ctx.clip();
    const wobble = b.collapsing ? Math.round(Math.sin(this.frame / 2) * 1.5) : 0;
    const x0 = b.x + wobble;
    ctx.fillStyle = b.color;
    ctx.fillRect(x0, roof, b.w, GROUND - b.roof);
    ctx.fillStyle = b.trim;
    ctx.fillRect(x0 - 2, roof - 3, b.w + 4, 3);
    // Rooftop sign.
    const signW = textWidth(b.name) + 6;
    const sx = Math.round(x0 + b.w / 2 - signW / 2);
    ctx.fillStyle = "#3a3a3a";
    ctx.fillRect(sx + 4, roof - 7, 2, 4);
    ctx.fillRect(sx + signW - 6, roof - 7, 2, 4);
    ctx.fillStyle = "#101018";
    ctx.fillRect(sx, roof - 17, signW, 10);
    drawText(ctx, b.name, x0 + b.w / 2, roof - 15, this.frame % 90 < 84 || b.collapsing ? "#f86878" : "#702030", { align: "center" });

    b.cells.forEach((row, r) => row.forEach((cell, c) => {
      const x = x0 + c * CELL_W;
      const y = roof + r * CELL_H;
      const door = r === b.floors - 1 && c === Math.floor(b.cols / 2);
      if (cell.hole) {
        ctx.fillStyle = "#140c0c";
        ctx.fillRect(x + 1, y + 1, CELL_W - 2, CELL_H - 2);
        ctx.fillStyle = b.trim;
        ctx.fillRect(x + 1, y + 1, 3, 2);
        ctx.fillRect(x + CELL_W - 5, y + CELL_H - 4, 4, 3);
        ctx.fillRect(x + 6, y + CELL_H - 3, 3, 2);
        return;
      }
      if (door) {
        ctx.fillStyle = "#3a2010";
        ctx.fillRect(x + 4, y + 3, 8, CELL_H - 3);
        ctx.fillStyle = "#f8d838";
        ctx.fillRect(x + 10, y + 8, 1, 1);
      } else {
        const lit = ((b.x + r * 7 + c * 13) % 5) > 1;
        ctx.fillStyle = b.trim;
        ctx.fillRect(x + 2, y + 2, 12, 10);
        ctx.fillStyle = cell.occupant ? "#f8e8a8" : lit ? "#f8d878" : "#28304a";
        ctx.fillRect(x + 3, y + 3, 10, 8);
        if (!cell.occupant) {
          ctx.fillStyle = lit ? "#e8b848" : "#384060";
          ctx.fillRect(x + 7, y + 3, 1, 8);
        }
      }
      if (cell.hp < CELL_HP) {
        ctx.fillStyle = "#1a1010";
        ctx.fillRect(x + 3, y + 2, 1, 4);
        ctx.fillRect(x + 4, y + 5, 3, 1);
        ctx.fillRect(x + 11, y + 7, 1, 5);
      }
      if (cell.occupant) this.drawOccupant(ctx, cell.occupant, x, y);
    }));
    ctx.restore();
  }

  private drawOccupant(ctx: CanvasRenderingContext2D, o: Occupant, x: number, y: number) {
    const pop = Math.min(1, o.age / 8);
    const yy = y + 3 + Math.round((1 - pop) * 8);
    if (o.kind === "food") {
      ctx.fillStyle = "#d8a050";
      ctx.fillRect(x + 3, yy + 3, 10, 2);
      ctx.fillStyle = "#58c838";
      ctx.fillRect(x + 3, yy + 5, 10, 1);
      ctx.fillStyle = "#e83820";
      ctx.fillRect(x + 4, yy + 6, 8, 1);
      ctx.fillStyle = "#c88840";
      ctx.fillRect(x + 3, yy + 7, 10, 1);
      if (this.frame % 30 < 15) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(x + 12, yy + 1, 1, 1);
      }
      return;
    }
    if (o.kind === "pepper") {
      ctx.fillStyle = "#e01810";
      ctx.fillRect(x + 5, yy + 3, 6, 3);
      ctx.fillRect(x + 7, yy + 6, 3, 2);
      ctx.fillStyle = "#38a818";
      ctx.fillRect(x + 6, yy + 2, 2, 1);
      if (this.frame % 20 < 10) {
        ctx.fillStyle = "#f8a020";
        ctx.fillRect(x + 4, yy + 1, 1, 1);
        ctx.fillRect(x + 11, yy + 2, 1, 1);
      }
      return;
    }
    const yelling = Math.floor(o.age / 10) % 2 === 0;
    ctx.fillStyle = o.kind === "manager" ? "#f0d050" : o.hair;
    if (o.kind === "manager") {
      ctx.fillRect(x + 4, yy - 1, 8, 3);
      ctx.fillRect(x + 3, yy + 1, 2, 5);
      ctx.fillRect(x + 11, yy + 1, 2, 5);
    } else ctx.fillRect(x + 5, yy, 6, 2);
    ctx.fillStyle = o.skin;
    ctx.fillRect(x + 5, yy + 2, 6, 5);
    ctx.fillStyle = "#000";
    ctx.fillRect(x + 6, yy + 3, 1, 1);
    ctx.fillRect(x + 9, yy + 3, 1, 1);
    ctx.fillStyle = "#600";
    ctx.fillRect(x + 7, yy + 5, 2, yelling ? 2 : 1);
    ctx.fillStyle = o.kind === "manager" ? "#9038b0" : "#3868c8";
    ctx.fillRect(x + 3, yy + 7, 10, 2);
    // Fist shaking out the window.
    ctx.fillStyle = o.skin;
    ctx.fillRect(yelling ? x + 12 : x + 13, yy + (yelling ? 1 : 3), 2, 2);
  }

  private drawBubbles(ctx: CanvasRenderingContext2D) {
    const shown = this.bubbles.slice(-3);
    for (const b of shown) {
      const w = textWidth(b.text) + 6;
      const x = Math.round(Math.max(2, Math.min(SCREEN_W - w - 2, b.x - w / 2)));
      const y = Math.round(Math.max(14, b.y - 12));
      ctx.fillStyle = "#000";
      ctx.fillRect(x - 1, y - 1, w + 2, 12);
      ctx.fillStyle = "#fcfcfc";
      ctx.fillRect(x, y, w, 10);
      ctx.fillRect(Math.round(Math.max(x + 2, Math.min(x + w - 4, b.x))), y + 10, 2, 2);
      drawText(ctx, b.text, x + 3, y + 2, "#000");
    }
  }

  private drawInspector(ctx: CanvasRenderingContext2D, i: Inspector) {
    const x = Math.round(i.flying ? i.fx : i.x);
    const y = Math.round(i.flying ? i.fy : GROUND);
    ctx.fillStyle = "#283858";
    ctx.fillRect(x - 3, y - 6, 2, 6);
    ctx.fillRect(x + 1, y - 6, 2, 6);
    ctx.fillStyle = "#e8e8e8";
    ctx.fillRect(x - 4, y - 14, 8, 8);
    ctx.fillStyle = "#f0c090";
    ctx.fillRect(x - 3, y - 19, 6, 5);
    ctx.fillStyle = "#283858";
    ctx.fillRect(x - 4, y - 21, 8, 2);
    ctx.fillStyle = "#000";
    ctx.fillRect(x - 2, y - 17, 4, 1);
    ctx.fillStyle = "#a07040";
    ctx.fillRect(x + 3, y - 13, 4, 5);
    ctx.fillStyle = "#fff";
    ctx.fillRect(x + 4, y - 12, 2, 3);
    if (!i.flying && i.lineT > 0) {
      const w = textWidth(i.line) + 6;
      const bx = Math.round(Math.max(2, Math.min(SCREEN_W - w - 2, x - w / 2)));
      ctx.fillStyle = "#fcfcfc";
      ctx.fillRect(bx, y - 34, w, 10);
      drawText(ctx, i.line, bx + 3, y - 32, "#283858");
    }
  }

  private drawCopter(ctx: CanvasRenderingContext2D, c: Copter) {
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    const flash = c.hurtT > 0 && c.hurtT % 4 < 2;
    ctx.fillStyle = flash ? "#fff" : "#d8d8e8";
    ctx.fillRect(x - 10, y - 4, 18, 9);
    ctx.fillRect(x + 8, y - 2, 12, 3);
    ctx.fillRect(x + 18, y - 5, 2, 6);
    ctx.fillStyle = "#68b8f8";
    ctx.fillRect(x - 9, y - 3, 6, 4);
    ctx.fillStyle = "#c82020";
    ctx.fillRect(x - 3, y, 10, 2);
    drawText(ctx, "1*", x - 2, y - 3, "#202020");
    ctx.fillStyle = "#404040";
    ctx.fillRect(x - 8, y + 6, 14, 1);
    ctx.fillRect(x - 1, y - 6, 2, 2);
    const blade = c.t % 6 < 3 ? 16 : 8;
    ctx.fillRect(x - blade, y - 7, blade * 2, 1);
  }

  private drawProjectile(ctx: CanvasRenderingContext2D, s: Projectile) {
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    if (s.kind === "star") {
      ctx.fillStyle = s.spin % 8 < 4 ? "#f8d838" : "#f89818";
      ctx.fillRect(x - 1, y - 3, 2, 6);
      ctx.fillRect(x - 3, y - 1, 6, 2);
      ctx.fillRect(x - 2, y - 2, 4, 4);
    } else if (s.kind === "cup") {
      ctx.fillStyle = "#f8f8f8";
      ctx.fillRect(x - 2, y - 3, 4, 6);
      ctx.fillStyle = "#784818";
      ctx.fillRect(x - 2, y - 3, 4, 1);
      ctx.fillStyle = "#c83020";
      ctx.fillRect(x - 2, y, 4, 1);
    } else if (s.kind === "phone") {
      ctx.fillStyle = "#202020";
      ctx.fillRect(x - 2, y - 3, 4, 6);
      ctx.fillStyle = s.spin % 10 < 5 ? "#68b8f8" : "#a8e8f8";
      ctx.fillRect(x - 1, y - 2, 2, 4);
    } else {
      ctx.fillStyle = "#f8f8f8";
      ctx.fillRect(x - 3, y - 2, 6, 4);
      ctx.fillStyle = "#c82020";
      ctx.fillRect(x - 2, y - 1, 4, 1);
    }
  }

  private drawPlayer(ctx: CanvasRenderingContext2D) {
    const p = this.player;
    if (p.invuln > 0 && p.mode !== "dead" && Math.floor(p.invuln / 3) % 2 === 0) return;
    let pose: Pose = "stand";
    if (p.mode === "dead") pose = "dead";
    else if (p.punchT > 4) pose = p.punchDir === "up" ? "punchUp" : p.punchDir === "down" ? "punchDown" : p.mode === "climb" ? "climbPunch" : "punch";
    else if (p.mode === "climb") pose = "climb";
    else if (p.mode === "air") pose = "air";
    else if (p.vx !== 0) pose = "walk";
    const shrink = p.mode === "dead" ? Math.max(0.35, 1 - p.deadT / 90) : 1;
    drawMonster(ctx, this.monster, p.x, p.y, p.facing, pose, p.walkT, shrink);
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#000000c0";
    ctx.fillRect(0, 0, SCREEN_W, 11);
    drawText(ctx, `SCORE ${String(this.score).padStart(6, "0")}`, 3, 2, "#fcfcfc");
    drawText(ctx, `${this.level}. ${this.streetName}`, SCREEN_W / 2 - 14, 2, "#f8d878", { align: "center" });
    const max = this.monster.patience;
    const barW = 50;
    const px = SCREEN_W - barW - 30;
    drawText(ctx, "PAT", px - 20, 2, "#a4e4fc");
    ctx.fillStyle = "#402020";
    ctx.fillRect(px, 3, barW, 5);
    const share = this.player.patience / max;
    ctx.fillStyle = share > 0.5 ? "#58d838" : share > 0.25 ? "#f8d838" : this.frame % 20 < 10 ? "#f83818" : "#a81808";
    ctx.fillRect(px, 3, Math.round(barW * share), 5);
    for (let i = 0; i < this.lives; i++) {
      ctx.fillStyle = this.monster.colors.body;
      ctx.fillRect(SCREEN_W - 26 + i * 8, 2, 6, 6);
      ctx.fillStyle = this.monster.colors.accent;
      ctx.fillRect(SCREEN_W - 25 + i * 8, 5, 4, 1);
    }
  }

  private panel(ctx: CanvasRenderingContext2D, lines: string[], top: number) {
    const w = Math.max(...lines.map((l) => textWidth(l))) + 20;
    const h = lines.length * 10 + 12;
    const x = Math.round(SCREEN_W / 2 - w / 2);
    ctx.fillStyle = "#000000d8";
    ctx.fillRect(x, top, w, h);
    ctx.fillStyle = "#f8d838";
    ctx.fillRect(x, top, w, 1);
    ctx.fillRect(x, top + h - 1, w, 1);
    lines.forEach((line, i) => drawText(ctx, line, SCREEN_W / 2, top + 7 + i * 10, i === 0 ? "#f8d838" : "#fcfcfc", { align: "center" }));
  }

  private drawIntro(ctx: CanvasRenderingContext2D) {
    const lines = [`BLOCK ${this.level}: ${this.streetName}`, "", "THE CUSTOMERS HAVE GATHERED.", "THEY HAVE NOTES."];
    if (this.level === 1) lines.push("", "PUNCH WALLS. HAND THEM SUBS.", "BRING IT ALL DOWN.");
    if (this.level === 2) lines.push("", "NEWS COPTER INBOUND. PUNCH UP.");
    this.panel(ctx, lines, 34);
  }

  private drawClear(ctx: CanvasRenderingContext2D) {
    const post = wrap(this.clearPost.toUpperCase(), 40).slice(0, 5);
    this.panel(ctx, [`${this.streetName}: CLEARED!`, `BONUS +${this.clearBonus}`, "", "OGDENSBURG COMMUNITY GROUP:", ...post], 26);
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    this.drawBackdrop(ctx);
    ctx.fillStyle = "#00000090";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    const bob = Math.round(Math.sin(this.frame / 12) * 2);
    drawText(ctx, "DELI RAMPAGE", SCREEN_W / 2 + 2, 10 + bob + 2, "#600010", { align: "center", scale: 3 });
    drawText(ctx, "DELI RAMPAGE", SCREEN_W / 2, 10 + bob, "#f8d838", { align: "center", scale: 3 });
    drawText(ctx, "ONE STAR MONSTER", SCREEN_W / 2, 38, "#f87858", { align: "center", scale: 1 });

    const m = this.monster;
    drawText(ctx, "<", 70, 92, "#f8d838", { scale: 2 });
    drawText(ctx, ">", 240, 92, "#f8d838", { scale: 2 });
    ctx.save();
    ctx.translate(SCREEN_W / 2, 0);
    ctx.scale(1.6, 1.6);
    drawMonster(ctx, m, 0, 82, this.frame % 120 < 60 ? 1 : -1, this.frame % 60 < 12 ? "punch" : "walk", this.frame, 1);
    ctx.restore();
    drawText(ctx, m.name, SCREEN_W / 2, 137, "#fcfcfc", { align: "center", scale: 2 });
    const tag = wrap(m.tagline, 50);
    tag.forEach((line, i) => drawText(ctx, line, SCREEN_W / 2, 152 + i * 8, "#bcbcbc", { align: "center" }));
    if (this.frame % 60 < 40) drawText(ctx, "PRESS START", SCREEN_W / 2, 170, "#f8d838", { align: "center" });

    drawText(ctx, "TOP RAMPAGERS", 8, 52, "#a4e4fc");
    const list = this.scores.slice(0, 5);
    if (!list.length) drawText(ctx, "NO SCORES YET", 8, 62, "#7c7c7c");
    list.forEach((s, i) => drawText(ctx, `${s.player_name.slice(0, 3).padEnd(3)} ${String(s.score).padStart(6)}`, 8, 62 + i * 9, "#fcfcfc"));
    const stat = (label: string, value: number, y: number) => {
      drawText(ctx, label, 236, y, "#a4e4fc");
      ctx.fillStyle = "#303030";
      ctx.fillRect(272, y + 1, 40, 5);
      ctx.fillStyle = "#f8d838";
      ctx.fillRect(272, y + 1, Math.round(40 * value), 5);
    };
    stat("SPEED", m.speed / 1.6, 52);
    stat("CLIMB", m.climb / 1.6, 62);
    stat("PUNCH", m.punch / 3, 72);
    stat("CHILL", m.patience / 130, 82);
  }

  private drawEntry(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#08081c";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    drawText(ctx, "NEW REVIEW!", SCREEN_W / 2, 20, "#f8d838", { align: "center", scale: 2 });
    drawText(ctx, `SCORE ${this.score} - BLOCK ${this.level}`, SCREEN_W / 2, 46, "#fcfcfc", { align: "center" });
    drawText(ctx, "SIGN YOUR COMPLAINT:", SCREEN_W / 2, 66, "#a4e4fc", { align: "center" });
    this.initials.forEach((letter, i) => {
      const x = SCREEN_W / 2 - 30 + i * 24;
      drawText(ctx, letter, x, 84, i === this.initialIndex ? "#f8d838" : "#fcfcfc", { scale: 3 });
      if (i === this.initialIndex && this.frame % 30 < 20) {
        ctx.fillStyle = "#f8d838";
        ctx.fillRect(x, 108, 15, 2);
      }
    });
    drawText(ctx, "UP/DOWN: LETTER   RIGHT/A: NEXT", SCREEN_W / 2, 130, "#7c7c7c", { align: "center" });
  }

  private drawScores(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#08081c";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    drawText(ctx, "HALL OF RAMPAGE", SCREEN_W / 2, 14, "#f8d838", { align: "center", scale: 2 });
    const list = this.scores.slice(0, 8);
    if (!list.length) drawText(ctx, "NO SCORES YET", SCREEN_W / 2, 60, "#7c7c7c", { align: "center" });
    list.forEach((s, i) => {
      const mine = s.player_name === this.initials.join("") && s.score === this.score;
      drawText(ctx, `${i + 1}. ${s.player_name.slice(0, 3).padEnd(3)}  ${String(s.score).padStart(7)}`, SCREEN_W / 2, 42 + i * 12, mine ? "#f8d838" : "#fcfcfc", { align: "center" });
    });
    if (this.submitted === "failed") drawText(ctx, "SCORE NOT SAVED (OFFLINE)", SCREEN_W / 2, 146, "#f87858", { align: "center" });
    if (this.stateT > 30 && this.frame % 60 < 40) drawText(ctx, "PRESS START", SCREEN_W / 2, 162, "#f8d838", { align: "center" });
  }
}

type Pose = "stand" | "walk" | "air" | "climb" | "punch" | "punchUp" | "punchDown" | "climbPunch" | "dead";

/** Draws a monster with its feet at (x, y), facing right when facing is 1. */
export function drawMonster(ctx: CanvasRenderingContext2D, m: Monster, x: number, y: number, facing: 1 | -1, pose: Pose, t: number, scale: number) {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  if (scale !== 1) ctx.scale(scale, scale);
  const r = (dx: number, dy: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(facing > 0 ? dx : -dx - w, dy, w, h);
  };
  const { body, trim, accent, eye } = m.colors;
  const step = pose === "walk" ? Math.floor(t / 6) % 4 : 0;
  const lift = (n: number) => (step === n ? -2 : 0);
  const skin = m.id === "cook" ? "#f0b080" : trim;
  const leg = m.id === "cook" ? "#707070" : m.id === "pickle" ? trim : "#c06810";

  // Legs.
  if (pose === "climb" || pose === "climbPunch") {
    const c = Math.floor(t / 8) % 2;
    r(-7, -9 - (c ? 3 : 0), 5, 9, leg);
    r(2, -9 - (c ? 0 : 3), 5, 9, leg);
  } else if (pose === "air") {
    r(-7, -11, 5, 8, leg);
    r(2, -9, 5, 8, leg);
  } else {
    r(-7, -9 + lift(1), 5, 9, leg);
    r(2, -9 + lift(3), 5, 9, leg);
    r(-8, -2 + lift(1), 7, 2, "#202020");
    r(1, -2 + lift(3), 7, 2, "#202020");
  }

  // Body and head.
  if (m.id === "cook") {
    r(-9, -26, 18, 18, body);
    r(-7, -22, 14, 13, "#e4e4e4");
    r(-6, -26, 12, 2, accent);
    r(-1, -24, 2, 3, accent);
    r(-6, -36, 12, 10, skin);
    r(-6, -42, 12, 6, "#ffffff");
    r(-8, -46, 16, 5, "#ffffff");
    r(-6, -47, 4, 2, "#ffffff");
    r(2, -47, 4, 2, "#ffffff");
    r(-6, -37, 12, 1, "#d8d8d8");
    r(1, -33, 2, 2, eye);
    r(-3, -33, 2, 2, eye);
    r(0, -35, 4, 1, "#402010");
    r(-4, -35, 3, 1, "#402010");
    r(-3, -29, 7, 1, "#802010");
    r(-2, -28, 5, 1, "#fff");
    r(-6, -32, 2, 4, "#d89060");
  } else if (m.id === "pickle") {
    r(-9, -40, 18, 32, body);
    r(-7, -43, 14, 3, body);
    r(-5, -45, 10, 2, body);
    for (const [dx, dy] of [[-6, -36], [4, -30], [-3, -22], [5, -16], [-7, -14], [1, -40]]) r(dx, dy, 2, 2, trim);
    r(-5, -34, 4, 4, "#fff");
    r(1, -34, 4, 4, "#fff");
    r(-3, -33, 2, 2, "#000");
    r(3, -33, 2, 2, "#000");
    r(-6, -36, 5, 1, "#123010");
    r(1, -36, 5, 1, "#123010");
    r(-4, -26, 9, 2, "#123010");
    r(-3, -25, 2, 1, "#fff");
    r(2, -25, 2, 1, "#fff");
    r(-9, -12, 18, 3, accent);
  } else {
    for (let i = 0; i < 30; i++) {
      const w = Math.max(2, Math.round(22 - i * 0.66));
      r(-Math.round(w / 2), -40 + i, w, 1, body);
    }
    r(-12, -43, 24, 5, trim);
    r(-11, -44, 22, 1, "#e8a040");
    r(-7, -32, 5, 5, accent);
    r(3, -26, 4, 4, accent);
    r(-3, -20, 4, 4, accent);
    r(-1, -14, 2, 2, accent);
    r(-6, -37, 4, 3, "#fff");
    r(1, -37, 4, 3, "#fff");
    r(-4, -36, 2, 2, eye);
    r(3, -36, 2, 2, eye);
    r(-6, -39, 4, 1, "#602000");
    r(1, -39, 4, 1, "#602000");
    r(-2, -31, 5, 1, "#602000");
    r(6, -20, 2, 4, "#f8e070");
  }

  // Arms.
  const shoulder = m.id === "slice" ? -34 : m.id === "pickle" ? -30 : -25;
  if (pose === "dead") {
    r(-12, shoulder + 6, 4, 8, skin);
    r(8, shoulder + 6, 4, 8, skin);
  } else if (pose === "punch" || pose === "climbPunch") {
    r(-12, shoulder + 1, 4, 9, skin);
    r(6, shoulder + 2, 13, 4, skin);
    r(17, shoulder, 6, 7, skin);
    r(23, shoulder + 2, 2, 3, "#fff");
  } else if (pose === "punchUp") {
    r(-12, shoulder + 1, 4, 9, skin);
    r(5, shoulder - 14, 4, 16, skin);
    r(4, shoulder - 20, 6, 6, skin);
  } else if (pose === "punchDown") {
    r(-12, shoulder + 1, 4, 9, skin);
    r(5, shoulder + 2, 4, 20, skin);
    r(4, shoulder + 20, 6, 6, skin);
  } else if (pose === "climb") {
    const c = Math.floor(t / 8) % 2;
    r(6, shoulder - 10 + (c ? 4 : 0), 4, 12, skin);
    r(-2, shoulder - 12 + (c ? 0 : 4), 4, 10, skin);
  } else if (pose === "air") {
    r(-13, shoulder - 6, 4, 9, skin);
    r(9, shoulder - 6, 4, 9, skin);
  } else {
    const swing = pose === "walk" ? (step % 2 ? 1 : -1) : 0;
    r(-12, shoulder + 1 + swing, 4, 10, skin);
    r(8, shoulder + 1 - swing, 4, 10, skin);
  }
  ctx.restore();
}
