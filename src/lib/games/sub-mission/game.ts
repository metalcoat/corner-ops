// SUB-MISSION: OVER THE COUNTER — a Punch-Out!!-style bout at the deli counter.
// A hangry customer reaches over the counter for your collar. Duck so they get stuck
// on the sneeze guard, dodge the coupon slaps, ring the bell to get out of a grip,
// and feed them (sample pickle, sub, or a whole JUMBO) until they fall into a food coma.
//
// Fixed 60 Hz simulation, 320x180 canvas, plain rectangles and the Deli Man pixel font.
// Nothing here touches the DOM except render() and the leaderboard calls, so the
// simulation runs in node tests.
import { DeliManAudio } from "../deli-man/audio";
import { drawText, textWidth, wrap } from "../deli-man/font";
import { Input } from "../deli-man/input";
import { PERFECT_ORDER_COMPLAINTS } from "../complaints";
import {
  CORNER_TIPS,
  CUSTOMERS,
  DUCK_LINES,
  ESCAPE_LINES,
  GRAB_LINES,
  SCREAMS,
  type Attack,
  type Customer,
  type ThrowKind,
} from "./data";

export const SCREEN_W = 320;
export const SCREEN_H = 180;
export const STEP_MS = 1000 / 60;
export const GAME_ID = "sub-mission";

const COUNTER_Y = 120;
const MAX_CHILL = 100;
const MAX_STARS = 3;
/** Knockdowns in one bout before you clock out for good. */
const MAX_DOWNS = 3;
const DODGE_T = 26;
const DUCK_T = 30;
const COUNT_T = 55;

type FoeState = "idle" | "taunt" | "windup" | "attack" | "grab" | "recover" | "stuck" | "gloat" | "ko";
type MeState = "idle" | "dodgeL" | "dodgeR" | "duck" | "jab" | "hook" | "jumbo" | "hurt" | "grabbed" | "down";
type Punch = "jab" | "hook" | "jumbo";
type State = "title" | "intro" | "fight" | "pause" | "koed" | "corner" | "champion" | "gameover" | "entry" | "scores";

export type Foe = {
  c: Customer;
  hangry: number;
  state: FoeState;
  t: number;
  dur: number;
  attack: Attack | null;
  /** Hank's double choke: the second reach comes right after a sidestep. */
  second: boolean;
  starGiven: boolean;
  hitT: number;
  bubble: string;
  bubbleT: number;
};
export type Me = {
  state: MeState;
  t: number;
  chill: number;
  downs: number;
  grip: number;
  mash: number;
  need: number;
  count: number;
  invuln: number;
};
type Thrown = { kind: ThrowKind; t: number; dur: number };
type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string };
type Floater = { x: number; y: number; text: string; color: string; t: number };
export type Score = { player_name: string; score: number };

const PUNCH = {
  jab: { dur: 12, impact: 5, damage: 3, block: 0.55 },
  hook: { dur: 26, impact: 15, damage: 8, block: 0.7 },
  jumbo: { dur: 40, impact: 22, damage: 28, block: 0 },
} as const;
const WINDUP: Record<Attack, number> = { choke: 50, double: 50, slap: 28, throw: 34, scream: 44 };
const CRUMBS = ["#f0d090", "#58b838", "#e83828", "#f8f0d0", "#b07040"];

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
  bout = 0;
  circuit = 1;
  score = 0;
  stars = 0;
  foe: Foe = this.freshFoe(0);
  me: Me = this.freshMe();
  thrown: Thrown | null = null;
  particles: Particle[] = [];
  floaters: Floater[] = [];
  scores: Score[] = [];
  scoresLoaded = false;
  initials = ["A", "A", "A"];
  initialIndex = 0;
  submitted: "idle" | "sending" | "sent" | "failed" = "idle";
  stateT = 0;
  fightT = 0;
  frame = 0;
  shake = 0;
  bell = 0;
  koBonus = 0;
  pickIndex = 0;
  review = "";
  tip = "";
  endReason = "";
  private rand: () => number;

  constructor(seed = Date.now()) {
    this.rand = mulberry32(seed);
  }

  /** Wind-ups get quicker every time around the circuit. */
  get pace() {
    return this.foe.c.speed * Math.pow(0.85, this.circuit - 1);
  }

  // ---------------------------------------------------------------- flow

  private pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)];
  }

  private setState(state: State) {
    this.state = state;
    this.stateT = 0;
    if (state === "title") this.audio.play("title");
    if (state === "intro" || state === "fight") this.audio.play(this.foe.c.id === "hank" ? "boss" : "stage2");
    if (state === "koed" || state === "champion") this.audio.play("victory");
    if (state === "gameover") this.audio.stopMusic();
  }

  private freshFoe(bout: number): Foe {
    const c = CUSTOMERS[bout % CUSTOMERS.length];
    const hangry = Math.round(c.hangry * (1 + (this.circuit - 1) * 0.2));
    return { c, hangry, state: "idle", t: 0, dur: 90, attack: null, second: false, starGiven: false, hitT: 0, bubble: "", bubbleT: 0 };
  }

  private freshMe(): Me {
    return { state: "idle", t: 0, chill: MAX_CHILL, downs: 0, grip: 0, mash: 0, need: 0, count: 0, invuln: 0 };
  }

  get maxHangry() {
    return Math.round(this.foe.c.hangry * (1 + (this.circuit - 1) * 0.2));
  }

  /** Starts at the customer picked on the title screen (practice on Hank if you like). */
  startGame(first = this.pickIndex) {
    this.bout = first;
    this.circuit = 1;
    this.score = 0;
    this.stars = 0;
    this.submitted = "idle";
    this.initials = ["A", "A", "A"];
    this.initialIndex = 0;
    this.me = this.freshMe();
    this.startBout();
  }

  private startBout() {
    const chill = this.me.chill;
    this.foe = this.freshFoe(this.bout);
    this.me = { ...this.freshMe(), chill };
    this.thrown = null;
    this.particles = [];
    this.floaters = [];
    this.fightT = 0;
    this.setState("intro");
  }

  pauseIfPlaying() {
    if (this.state === "fight") this.setState("pause");
  }

  /** A tap on the screen: starts the game from the menus. */
  tap(x: number, _y: number) {
    this.audio.unlock();
    if (this.state === "title") {
      if (x < SCREEN_W * 0.3) this.cyclePick(-1);
      else if (x > SCREEN_W * 0.7) this.cyclePick(1);
      else this.startGame();
    } else if (this.state === "scores") this.setState("title");
    else if (this.state === "pause") this.setState("fight");
  }

  private cyclePick(step: number) {
    this.pickIndex = (this.pickIndex + step + CUSTOMERS.length) % CUSTOMERS.length;
    this.audio.sfx("move");
  }

  // ---------------------------------------------------------------- update

  update() {
    this.input.poll();
    this.frame++;
    this.stateT++;
    if (this.shake > 0) this.shake--;
    if (this.bell > 0) this.bell--;
    const go = this.input.pressed("start") || this.input.pressed("jump") || this.input.pressed("shoot");
    switch (this.state) {
      case "title":
        if (this.stateT === 1 && !this.scoresLoaded) void this.loadScores();
        if (this.input.pressed("left")) this.cyclePick(-1);
        if (this.input.pressed("right")) this.cyclePick(1);
        if (go) {
          this.audio.sfx("ready");
          this.startGame();
        }
        break;
      case "intro":
        if (this.stateT > 200 || (this.stateT > 30 && go)) this.setState("fight");
        break;
      case "fight":
        if (this.input.pressed("start")) {
          this.setState("pause");
          this.audio.sfx("pause");
          break;
        }
        this.updateFight();
        break;
      case "pause":
        if (this.input.pressed("start")) {
          this.setState("fight");
          this.audio.sfx("pause");
        }
        break;
      case "koed":
        this.foe.t++;
        this.updateEffects();
        if (this.stateT > 170) this.setState("corner");
        break;
      case "corner":
        if (this.stateT > 600 || (this.stateT > 45 && go)) this.nextBout();
        break;
      case "champion":
        if (this.stateT > 420 || (this.stateT > 60 && go)) {
          this.circuit++;
          this.bout = 0;
          this.startBout();
        }
        break;
      case "gameover":
        this.updateEffects();
        if (this.stateT > 180 || (this.stateT > 50 && go)) this.setState(this.score > 0 ? "entry" : "scores");
        break;
      case "entry":
        this.updateEntry();
        break;
      case "scores":
        if (this.stateT > 30 && go) this.setState("title");
        break;
    }
  }

  private nextBout() {
    this.me.chill = Math.min(MAX_CHILL, this.me.chill + 40);
    if (this.bout === CUSTOMERS.length - 1) {
      this.setState("champion");
      return;
    }
    this.bout++;
    this.startBout();
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

  private updateFight() {
    this.fightT++;
    this.updateMe();
    this.updateFoe();
    this.updateThrown();
    this.updateEffects();
  }

  // ---------------------------------------------------------------- you

  private updateMe() {
    const me = this.me;
    me.t++;
    if (me.invuln > 0) me.invuln--;
    const punchPressed = this.input.pressed("shoot") || this.input.pressed("jump");
    switch (me.state) {
      case "idle": {
        if (this.input.pressed("left")) return this.meTo("dodgeL");
        if (this.input.pressed("right")) return this.meTo("dodgeR");
        if (this.input.pressed("down")) return this.meTo("duck");
        if (punchPressed && this.input.held("up")) {
          if (this.stars > 0) {
            this.stars--;
            this.audio.sfx("weapon");
            this.float(160, 100, "THE JUMBO!", "#f8d838");
            return this.meTo("jumbo");
          }
          this.float(160, 100, "NO TIP STARS", "#bcbcbc");
          return;
        }
        if (this.input.pressed("shoot")) return this.meTo("jab");
        if (this.input.pressed("jump")) return this.meTo("hook");
        return;
      }
      case "dodgeL":
      case "dodgeR":
        if (me.t >= DODGE_T) this.meTo("idle");
        return;
      case "duck":
        if (me.t >= DUCK_T) this.meTo("idle");
        return;
      case "jab":
      case "hook":
      case "jumbo": {
        const spec = PUNCH[me.state];
        if (me.t === spec.impact) this.landPunch(me.state);
        if (me.t >= spec.dur) this.meTo("idle");
        return;
      }
      case "hurt":
        if (me.t >= 22) this.meTo("idle");
        return;
      case "grabbed": {
        const hank = this.foe.c.id === "hank";
        me.chill -= hank ? 0.2 : 0.15;
        if (punchPressed) {
          me.grip--;
          this.bell = 8;
          this.audio.sfx("tick");
          this.float(272, 96, "DING!", "#f8d838");
        }
        if (me.t % 70 === 1) this.float(160, 112, this.pick(GRAB_LINES), "#fcfcfc");
        if (me.grip <= 0) {
          this.score += 200;
          this.meTo("idle");
          me.invuln = 30;
          this.audio.sfx("select");
          this.float(160, 70, this.pick(ESCAPE_LINES), "#58d838");
          this.foeTo("recover", 70);
        } else if (me.chill <= 0) this.knockdown();
        return;
      }
      case "down": {
        if (me.t % COUNT_T === 0) {
          me.count++;
          this.audio.sfx("tick");
          if (me.count >= 10) {
            this.endReason = "COUNTED OUT BY THE HEALTH INSPECTOR.";
            return this.gameOver();
          }
        }
        if (punchPressed) me.mash++;
        if (me.mash >= me.need) {
          me.chill = MAX_CHILL * (0.7 - me.downs * 0.15);
          this.meTo("idle");
          me.invuln = 60;
          this.audio.sfx("oneUp");
          this.float(160, 90, "BACK ON THE CLOCK!", "#58d838");
          this.foeTo("idle", 50);
        }
        return;
      }
    }
  }

  private meTo(state: MeState) {
    this.me.state = state;
    this.me.t = 0;
    if (state === "dodgeL" || state === "dodgeR" || state === "duck") this.audio.sfx("move");
    if (state === "jab" || state === "hook") this.audio.sfx("shoot");
  }

  hurt(amount: number, label: string) {
    const me = this.me;
    if (me.invuln > 0 || me.state === "down") return;
    me.chill = Math.max(0, me.chill - amount);
    this.shake = 10;
    this.audio.sfx("hurt");
    this.float(160, 120, `${label} -${amount}`, "#f87858");
    if (me.chill <= 0) this.knockdown();
    else this.meTo("hurt");
  }

  private knockdown() {
    const me = this.me;
    me.downs++;
    me.chill = 0;
    this.shake = 16;
    this.audio.sfx("death");
    if (me.downs >= MAX_DOWNS) {
      this.endReason = `${this.foe.c.name} GOT YOU ${MAX_DOWNS} TIMES. TKO.`;
      return this.gameOver();
    }
    this.meTo("down");
    me.count = 0;
    me.mash = 0;
    me.need = 6 + me.downs * 6;
    // The customer feels great about this.
    this.foe.hangry = Math.min(this.maxHangry, this.foe.hangry + 15);
    this.foeTo("gloat", 9999);
    this.say(this.pick(this.foe.c.taunts));
  }

  private gameOver() {
    this.me.state = "down";
    this.foe.state = "gloat";
    this.setState("gameover");
  }

  // ---------------------------------------------------------------- punches

  landPunch(kind: Punch) {
    const f = this.foe;
    const spec = PUNCH[kind];
    let damage: number = spec.damage;
    if (f.state === "ko" || f.state === "grab") return;
    if (f.state === "attack" && (f.attack === "choke" || f.attack === "double" || f.attack === "slap")) return this.whiff();
    if (f.state === "recover" || f.state === "taunt" || f.state === "attack") {
      damage *= 2;
    } else if (f.state === "stuck") {
      damage = Math.round(damage * 2.5);
      if (!f.starGiven) {
        f.starGiven = true;
        this.addStar("TIP! +1 STAR");
      }
    } else if (f.state === "windup") {
      const armored = f.attack === "choke" || f.attack === "double";
      if (!armored && f.t < f.dur * 0.45) {
        damage = Math.round(damage * 1.5);
        this.addStar("INTERRUPTED! +1 STAR");
        this.foeTo("recover", 30);
      } else if (kind !== "jumbo") {
        damage = Math.ceil(damage / 2);
        if (armored) this.float(160, 30, "NOT STOPPING!", "#f87858");
      }
    } else if (this.rand() < spec.block) {
      this.audio.sfx("tink");
      this.float(108, 58, "BLOCKED!", "#bcbcbc");
      // A blocked sub gets a quick slap back.
      if (kind === "hook") this.startAttack("slap", 14);
      return;
    }
    f.hangry = Math.max(0, f.hangry - damage);
    f.hitT = 10;
    this.score += damage * 10;
    this.shake = Math.max(this.shake, kind === "jumbo" ? 14 : 4);
    this.audio.sfx(kind === "jab" ? "hit" : "bossHit");
    this.burst(160, 52, kind === "jumbo" ? 24 : 8);
    this.float(214, 58, kind === "jab" ? `PICKLE +${damage}` : kind === "hook" ? `SUB +${damage}` : `JUMBO +${damage}`, "#58d838");
    if (f.hangry <= 0) this.foodComa();
  }

  private whiff() {
    this.audio.sfx("tink");
    this.float(108, 58, "WHIFF", "#bcbcbc");
  }

  private addStar(label: string) {
    if (this.stars >= MAX_STARS) return;
    this.stars++;
    this.audio.sfx("pickup");
    this.float(80, 24, label, "#f8d838");
  }

  private foodComa() {
    const f = this.foe;
    this.foeTo("ko", 9999);
    this.thrown = null;
    this.audio.sfx("explode");
    this.koBonus = 1000 * (this.bout + 1) * this.circuit + Math.round(this.me.chill) * 10 + Math.max(0, Math.floor((3600 - this.fightT) / 2));
    this.score += this.koBonus;
    this.review = this.pick(PERFECT_ORDER_COMPLAINTS);
    this.tip = this.pick(CORNER_TIPS);
    this.float(160, 30, "FOOD COMA!", "#f8d838");
    if (this.me.state !== "down") this.meTo("idle");
    f.bubble = "";
    this.setState("koed");
  }

  // ---------------------------------------------------------------- the customer

  private foeTo(state: FoeState, dur: number) {
    const f = this.foe;
    f.state = state;
    f.t = 0;
    f.dur = dur;
    if (state === "stuck") f.starGiven = false;
  }

  private say(text: string) {
    this.foe.bubble = text;
    this.foe.bubbleT = 150;
  }

  /** Starts an attack's wind-up. `windup` overrides the usual length (quick counters, tests). */
  startAttack(kind: Attack, windup?: number) {
    const f = this.foe;
    f.attack = kind;
    f.second = false;
    this.foeTo("windup", windup ?? Math.round(WINDUP[kind] * this.pace));
    if (kind === "choke" || kind === "double") this.float(160, 22, "!!", "#f83818");
    if (kind === "scream") this.say(this.pick(SCREAMS));
  }

  private chooseAttack(): Attack {
    const list = this.foe.c.attacks;
    let roll = this.rand() * list.reduce((sum, a) => sum + a.weight, 0);
    for (const a of list) {
      roll -= a.weight;
      if (roll <= 0) return a.kind;
    }
    return list[0].kind;
  }

  private updateFoe() {
    const f = this.foe;
    f.t++;
    if (f.hitT > 0) f.hitT--;
    if (f.bubbleT > 0 && --f.bubbleT === 0) f.bubble = "";
    switch (f.state) {
      case "idle":
        if (f.t >= f.dur) {
          if (this.rand() < 0.16) {
            this.foeTo("taunt", 70);
            this.say(this.pick(f.c.taunts));
          } else this.startAttack(this.chooseAttack());
        }
        return;
      case "taunt":
      case "recover":
      case "stuck":
        if (f.t >= f.dur) this.foeTo("idle", Math.round((40 + this.rand() * 60) * this.pace));
        return;
      case "windup":
        if (f.t >= f.dur) {
          const kind = f.attack!;
          const reach = kind === "throw" ? 32 : kind === "scream" ? 36 : kind === "slap" ? 6 : 10;
          this.foeTo("attack", reach);
          if (kind === "throw") this.thrown = { kind: f.c.throws, t: 0, dur: reach };
          if (kind === "slap") this.audio.sfx("shoot");
          if (kind === "scream") this.audio.sfx("honk");
        }
        return;
      case "attack":
        if (f.t >= f.dur) this.resolveAttack();
        return;
      case "grab":
        if (this.me.state !== "grabbed") this.foeTo("recover", 60);
        return;
      case "gloat":
      case "ko":
        return;
    }
  }

  /** The moment an attack arrives: did you get out of the way? */
  private resolveAttack() {
    const f = this.foe;
    const me = this.me.state;
    const sidestep = me === "dodgeL" || me === "dodgeR";
    switch (f.attack) {
      case "choke":
      case "double":
        if (me === "duck") {
          this.foeTo("stuck", Math.round(120 / Math.max(0.8, this.pace)));
          this.audio.sfx("thud");
          this.shake = 8;
          this.float(160, 80, this.pick(DUCK_LINES), "#a4e4fc");
        } else if (sidestep && f.attack === "double" && !f.second) {
          this.foeTo("windup", Math.round(24 * this.pace));
          f.second = true;
          this.float(160, 22, "AGAIN!!", "#f83818");
        } else if (sidestep) {
          this.foeTo("recover", 55);
          this.float(160, 80, "WHIFF! WIDE OPEN!", "#a4e4fc");
        } else if (this.me.invuln > 0) {
          this.foeTo("recover", 40);
        } else {
          this.foeTo("grab", 9999);
          this.meTo("grabbed");
          this.me.grip = f.c.grip + (this.circuit - 1) * 4;
          this.shake = 12;
          this.audio.sfx("hurt");
          this.float(160, 70, "OVER THE COUNTER!", "#f83818");
          this.float(272, 86, "MASH! RING THE BELL!", "#f8d838");
        }
        return;
      case "slap":
        if (sidestep) {
          this.foeTo("recover", 45);
          this.float(160, 80, "DODGED!", "#a4e4fc");
        } else {
          this.hurt(12, f.c.id === "carol" ? "COUPON SLAP" : "SLAP");
          this.foeTo("recover", 24);
        }
        return;
      case "throw":
        this.thrown = null;
        if (sidestep || me === "duck") {
          this.foeTo("recover", 40);
          this.float(160, 80, "MISSED!", "#a4e4fc");
        } else {
          this.hurt(10, f.c.throws === "ranch" ? "RANCHED" : f.c.throws === "coupon" ? "COUPONED" : "1 STAR");
          this.foeTo("recover", 26);
        }
        return;
      case "scream":
        if (me === "duck") {
          this.foeTo("recover", 50);
          this.float(160, 80, "DUCKED THE SCREAM!", "#a4e4fc");
        } else {
          this.hurt(14, "EARS RINGING");
          this.foeTo("recover", 26);
        }
        return;
      default:
        this.foeTo("idle", 60);
    }
  }

  private updateThrown() {
    if (this.thrown) this.thrown.t++;
  }

  private updateEffects() {
    for (const q of this.particles) {
      q.x += q.vx;
      q.y += q.vy;
      q.vy += 0.14;
      q.life--;
    }
    this.particles = this.particles.filter((q) => q.life > 0);
    for (const f of this.floaters) {
      f.t++;
      f.y -= 0.3;
    }
    this.floaters = this.floaters.filter((f) => f.t < 80);
  }

  private float(x: number, y: number, text: string, color: string) {
    while (this.floaters.some((f) => f.t < 40 && Math.abs(f.y - y) < 9 && Math.abs(f.x - x) < (textWidth(f.text) + textWidth(text)) / 2)) y -= 9;
    this.floaters.push({ x, y: Math.max(14, y), text, color, t: 0 });
  }

  private burst(x: number, y: number, n: number) {
    for (let i = 0; i < n; i++)
      this.particles.push({ x, y, vx: (this.rand() - 0.5) * 3.4, vy: -this.rand() * 2.6, life: 26 + Math.floor(this.rand() * 18), color: this.pick(CRUMBS) });
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
        body: JSON.stringify({ gameId: GAME_ID, playerName: entry.player_name, score: this.score, metadata: { circuit: this.circuit, customer: this.foe.c.id } }),
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
    drawStore(ctx, this.frame, this.bout);
    const pose = this.pose();
    const front = pose === "choke" || pose === "grab";
    if (!front) this.drawFoe(ctx, pose);
    drawSneezeGuard(ctx);
    drawCounter(ctx, this.bell);
    if (pose === "stuck") this.drawStuckFace(ctx);
    if (front) this.drawFoe(ctx, pose);
    if (this.thrown) drawThrown(ctx, this.thrown, this.frame);
    if (this.foe.state === "attack" && this.foe.attack === "scream") this.drawScream(ctx);
    this.drawMe(ctx);
    for (const q of this.particles) {
      ctx.fillStyle = q.color;
      ctx.fillRect(Math.round(q.x), Math.round(q.y), 2, 2);
    }
    for (const f of this.floaters) {
      if (f.t > 60 && f.t % 4 < 2) continue;
      drawText(ctx, f.text, Math.max(textWidth(f.text) / 2 + 2, Math.min(SCREEN_W - textWidth(f.text) / 2 - 2, f.x)), f.y, f.color, { align: "center", shadow: "#000" });
    }
    this.drawBubble(ctx);
    ctx.restore();
    this.drawHud(ctx);
    if (this.me.state === "grabbed" && this.frame % 16 < 8) {
      ctx.strokeStyle = "#f83818";
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 12.5, SCREEN_W - 3, SCREEN_H - 14);
    }
    if (this.me.state === "down" && this.state === "fight") this.drawCount(ctx);
    if (this.state === "intro") this.drawIntro(ctx);
    if (this.state === "pause") this.panel(ctx, ["PAUSED", "", "THE LINE IS STILL THERE.", "", "PRESS START"], 50);
    if (this.state === "corner") this.drawCorner(ctx);
    if (this.state === "champion")
      this.panel(ctx, ["EMPLOYEE OF THE MONTH!", "", "PAY RAISE: ONE FREE FOUNTAIN SODA.", "", "BAD NEWS: THE LINE GOT LONGER.", `CIRCUIT ${this.circuit + 1}: THE DINNER RUSH`], 40);
    if (this.state === "gameover") this.panel(ctx, ["YOU CLOCKED OUT", "", ...wrap(this.endReason, 40), "", "THE CUSTOMER IS ALWAYS RIGHT.", "ALLEGEDLY."], 46);
  }

  private pose(): Pose {
    const f = this.foe;
    if (f.state === "windup") return f.attack === "choke" || f.attack === "double" ? "windChoke" : f.attack === "slap" ? "windSlap" : f.attack === "throw" ? "windThrow" : "windScream";
    if (f.state === "attack") return f.attack === "choke" || f.attack === "double" ? "choke" : f.attack === "slap" ? "slap" : f.attack === "throw" ? "throw" : "scream";
    if (f.state === "grab") return "grab";
    if (f.state === "idle") return "guard";
    return f.state;
  }

  private drawFoe(ctx: CanvasRenderingContext2D, pose: Pose) {
    const f = this.foe;
    const sway = pose === "guard" ? Math.round(Math.sin(this.frame / 14) * 4) : 0;
    let lean = 0;
    if (pose === "choke") lean = Math.min(1, f.t / Math.max(1, f.dur));
    if (pose === "grab") lean = 1;
    const jolt = f.hitT > 0 ? (f.hitT % 4 < 2 ? -2 : 2) : 0;
    const grabShake = pose === "grab" ? (this.frame % 6 < 3 ? -1 : 1) : 0;
    ctx.save();
    ctx.translate(160 + sway + jolt + grabShake, COUNTER_Y + Math.round(lean * 20));
    const s = 1 + lean * 0.45;
    ctx.scale(s, s);
    drawCustomer(ctx, f.c, pose, f.t, this.frame, f.hitT > 0 && f.hitT % 4 < 2);
    ctx.restore();
  }

  /** Face pressed flat against the sneeze guard. */
  private drawStuckFace(ctx: CanvasRenderingContext2D) {
    const c = this.foe.c;
    const wob = Math.round(Math.sin(this.frame / 3));
    const x = 140, y = 92;
    ctx.fillStyle = c.colors.skin;
    ctx.fillRect(x - 4, y, 48, 22);
    ctx.fillRect(x, y - 3, 40, 28);
    ctx.fillStyle = "#e89090";
    ctx.fillRect(x + 15, y + 8, 10, 6); // flattened nose
    ctx.fillStyle = "#fcfcfc";
    ctx.fillRect(x + 4, y + 3, 8, 6);
    ctx.fillRect(x + 28, y + 3, 8, 6);
    ctx.fillStyle = "#101010";
    ctx.fillRect(x + 9 + wob, y + 5, 3, 3); // crossed eyes
    ctx.fillRect(x + 28 - wob, y + 5, 3, 3);
    ctx.fillStyle = "#802020";
    ctx.fillRect(x + 10, y + 17, 20, 4);
    ctx.fillStyle = "#ffffff70";
    ctx.fillRect(x + 2, y - 2, 3, 26);
    ctx.fillRect(x + 34, y - 2, 2, 26);
    // Birdies.
    for (let i = 0; i < 3; i++) {
      const a = this.frame / 10 + (i * Math.PI * 2) / 3;
      drawText(ctx, "*", x + 20 + Math.cos(a) * 26, y - 14 + Math.sin(a) * 5, "#f8d838");
    }
  }

  private drawScream(ctx: CanvasRenderingContext2D) {
    const t = this.foe.t;
    ctx.strokeStyle = "#f8f8f8";
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const r = ((t * 3 + i * 26) % 90) + 6;
      ctx.globalAlpha = Math.max(0, 1 - r / 96);
      ctx.beginPath();
      ctx.ellipse(160, 60, r * 1.4, r * 0.8, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawMe(ctx: CanvasRenderingContext2D) {
    const me = this.me;
    let x = 160, y = 0;
    const k = Math.max(0, Math.min(1, me.t / 5, ((me.state === "duck" ? DUCK_T : DODGE_T) - me.t) / 5));
    if (me.state === "dodgeL") x -= Math.round(58 * k);
    if (me.state === "dodgeR") x += Math.round(58 * k);
    if (me.state === "duck") y += Math.round(36 * k);
    if (me.state === "hurt") x += me.t % 6 < 3 ? -3 : 3;
    if (me.state === "grabbed") {
      y -= 6;
      x += this.frame % 4 < 2 ? -2 : 2;
    }
    if (me.state === "down") y += 58;
    if (me.invuln > 0 && me.state !== "down" && this.frame % 6 < 2) return;
    ctx.save();
    ctx.globalAlpha = 0.93;
    drawEmployee(ctx, x, y, me.state, me.t, this.grabbedRed());
    ctx.restore();
  }

  private grabbedRed() {
    return this.me.state === "grabbed" ? Math.min(1, this.me.t / 90) : 0;
  }

  private drawBubble(ctx: CanvasRenderingContext2D) {
    const f = this.foe;
    if (!f.bubble || this.state === "intro") return;
    const lines = wrap(f.bubble, 16).slice(0, 3);
    const w = Math.max(...lines.map((l) => textWidth(l))) + 8;
    const h = lines.length * 9 + 5;
    const x = 204, y = 18;
    ctx.fillStyle = "#fcfcfc";
    ctx.fillRect(x, y, w, h);
    ctx.fillRect(x - 6, y + h - 6, 8, 3);
    ctx.fillRect(x - 10, y + h - 3, 5, 3);
    lines.forEach((l, i) => drawText(ctx, l, x + 4, y + 3 + i * 9, "#101010"));
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#000000c8";
    ctx.fillRect(0, 0, SCREEN_W, 11);
    const bar = (x: number, w: number, share: number, good: boolean) => {
      ctx.fillStyle = "#402020";
      ctx.fillRect(x, 3, w, 5);
      ctx.fillStyle = good ? (share > 0.5 ? "#58d838" : share > 0.25 ? "#f8d838" : this.frame % 20 < 10 ? "#f83818" : "#a81808") : "#f87818";
      ctx.fillRect(x, 3, Math.round(w * Math.max(0, share)), 5);
    };
    drawText(ctx, "CHILL", 3, 2, "#a4e4fc");
    bar(34, 52, this.me.chill / MAX_CHILL, true);
    drawText(ctx, "TIPS", 92, 2, "#f8d838");
    for (let i = 0; i < MAX_STARS; i++) drawText(ctx, "*", 119 + i * 7, 2, i < this.stars ? "#f8d838" : "#404040");
    drawText(ctx, String(this.score).padStart(7, "0"), 145, 2, "#fcfcfc");
    drawText(ctx, "HANGRY", 194, 2, "#f87858");
    bar(232, 84, this.foe.hangry / this.maxHangry, false);
    for (let i = 0; i < this.me.downs; i++) drawText(ctx, "X", 3 + i * 7, 13, "#f83818", { shadow: "#000" });
  }

  private drawCount(ctx: CanvasRenderingContext2D) {
    const me = this.me;
    this.panel(ctx, ["YOU'RE DOWN!", "", `HEALTH INSPECTOR: ${me.count || "..."}`, "", `MASH TO GET UP  ${me.mash}/${me.need}`], 44);
  }

  private panel(ctx: CanvasRenderingContext2D, lines: string[], top: number) {
    const w = Math.max(...lines.map((l) => textWidth(l))) + 20;
    const h = lines.length * 10 + 12;
    const x = Math.round(SCREEN_W / 2 - w / 2);
    ctx.fillStyle = "#000000dc";
    ctx.fillRect(x, top, w, h);
    ctx.fillStyle = "#f8d838";
    ctx.fillRect(x, top, w, 1);
    ctx.fillRect(x, top + h - 1, w, 1);
    lines.forEach((line, i) => drawText(ctx, line, SCREEN_W / 2, top + 7 + i * 10, i === 0 ? "#f8d838" : "#fcfcfc", { align: "center" }));
  }

  private drawIntro(ctx: CanvasRenderingContext2D) {
    const c = this.foe.c;
    const lines = [`NOW SERVING #${67 + this.bout + (this.circuit - 1) * 4}`, "", c.name, c.title, "", ...wrap(c.intro, 42)];
    if (this.bout === 0 && this.circuit === 1) lines.push("", "DOWN: DUCK  LEFT/RIGHT: DODGE", "X: SAMPLE PICKLE  Z: SUB", "UP+PUNCH: THE JUMBO (1 TIP STAR)");
    this.panel(ctx, lines, this.bout === 0 && this.circuit === 1 ? 18 : 36);
  }

  private drawCorner(ctx: CanvasRenderingContext2D) {
    const review = wrap(this.review.toUpperCase(), 46).slice(0, 4);
    const tip = wrap(this.tip, 46);
    this.panel(ctx, [`FOOD COMA! +${this.koBonus}`, ...wrap(this.foe.c.koLine, 46), "", "ONE-STAR REVIEW POSTED ANYWAY:", ...review, "", "THE MANAGER (FROM THE WALK-IN):", ...tip], 14);
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    drawStore(ctx, this.frame, 3);
    const c = CUSTOMERS[this.pickIndex];
    ctx.save();
    ctx.translate(160, COUNTER_Y);
    drawCustomer(ctx, c, this.frame % 240 < 180 ? "guard" : "windChoke", 0, this.frame, false);
    ctx.restore();
    drawSneezeGuard(ctx);
    drawCounter(ctx, 0);
    ctx.fillStyle = "#00000088";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    const bob = Math.round(Math.sin(this.frame / 12) * 2);
    drawText(ctx, "SUB-MISSION", SCREEN_W / 2 + 2, 12 + bob + 2, "#600010", { align: "center", scale: 3 });
    drawText(ctx, "SUB-MISSION", SCREEN_W / 2, 12 + bob, "#f8d838", { align: "center", scale: 3 });
    drawText(ctx, "OVER THE COUNTER", SCREEN_W / 2, 40, "#f87858", { align: "center" });
    drawText(ctx, "<", 104, 132, "#f8d838", { scale: 2 });
    drawText(ctx, ">", 206, 132, "#f8d838", { scale: 2 });
    drawText(ctx, c.name, SCREEN_W / 2, 136, "#fcfcfc", { align: "center" });
    drawText(ctx, "DUCK. DODGE. FEED. RING THE BELL.", SCREEN_W / 2, 148, "#bcbcbc", { align: "center" });
    if (this.frame % 60 < 40) drawText(ctx, "PRESS START", SCREEN_W / 2, 164, "#f8d838", { align: "center" });
    rect(ctx, 4, 52, 88, 56, "#000000b0");
    rect(ctx, 240, 52, 76, 58, "#000000b0");
    drawText(ctx, "TOP SERVERS", 8, 56, "#a4e4fc");
    const list = this.scores.slice(0, 5);
    if (!list.length) drawText(ctx, "NO SCORES YET", 8, 66, "#7c7c7c");
    list.forEach((s, i) => drawText(ctx, `${s.player_name.slice(0, 3).padEnd(3)} ${String(s.score).padStart(6)}`, 8, 66 + i * 9, "#fcfcfc"));
    const keys = ["DOWN  DUCK", "L/R   DODGE", "X     PICKLE", "Z     SUB", "UP+X  JUMBO", "MASH  BELL"];
    keys.forEach((k, i) => drawText(ctx, k, 244, 56 + i * 9, i % 2 ? "#fcfcfc" : "#a4e4fc"));
  }

  private drawEntry(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#08081c";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    drawText(ctx, "SHIFT OVER!", SCREEN_W / 2, 20, "#f8d838", { align: "center", scale: 2 });
    drawText(ctx, `SCORE ${this.score} - CUSTOMER #${67 + this.bout + (this.circuit - 1) * 4}`, SCREEN_W / 2, 46, "#fcfcfc", { align: "center" });
    drawText(ctx, "SIGN THE TIME SHEET:", SCREEN_W / 2, 66, "#a4e4fc", { align: "center" });
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
    drawText(ctx, "EMPLOYEES OF THE MONTH", SCREEN_W / 2, 14, "#f8d838", { align: "center", scale: 2 });
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

// ---------------------------------------------------------------- drawing

type Pose =
  | "guard" | "windChoke" | "choke" | "grab" | "windSlap" | "slap" | "windThrow" | "throw"
  | "windScream" | "scream" | "taunt" | "recover" | "stuck" | "gloat" | "ko";

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** A thick straight limb from (x1,y1) to (x2,y2). */
function limb(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, w: number, color: string) {
  ctx.fillStyle = color;
  const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    ctx.fillRect(x1 + (x2 - x1) * k - w / 2, y1 + (y2 - y1) * k - w / 2, w, w);
  }
}

function drawStore(ctx: CanvasRenderingContext2D, frame: number, lineLength: number) {
  rect(ctx, 0, 0, SCREEN_W, COUNTER_Y, "#ecdcb0");
  rect(ctx, 0, COUNTER_Y - 34, SCREEN_W, 34, "#d8c490");
  for (let x = 0; x < SCREEN_W; x += 12) rect(ctx, x, COUNTER_Y - 34, 1, 34, "#c8b480");
  // Front windows, lettering backwards from in here.
  for (const wx of [8, 222]) {
    rect(ctx, wx, 18, 90, 64, "#5a6a7a");
    rect(ctx, wx + 3, 21, 84, 58, "#8ec8e8");
    rect(ctx, wx + 3, 64, 84, 15, "#7a7a80");
    rect(ctx, wx + 3, 62, 84, 2, "#5a5a60");
  }
  drawText(ctx, "ILED", 53, 26, "#d82800", { align: "center", scale: 2 });
  drawText(ctx, "RENROC", 53, 44, "#d82800", { align: "center" });
  if (frame % 90 < 70) {
    drawText(ctx, "NEPO", 267, 28, "#f83878", { align: "center", scale: 2, shadow: "#80104080" });
  }
  // The line outside, getting longer.
  for (let i = 0; i < 2 + lineLength; i++) {
    const x = 232 + i * 14 - (i > 4 ? 70 : 0);
    const bob = Math.round(Math.sin(frame / 20 + i) * 1);
    rect(ctx, x, 50 + bob, 8, 8, ["#f0c090", "#a86838", "#d89060"][i % 3]);
    rect(ctx, x - 1, 58 + bob, 10, 10, ["#4878c8", "#c05890", "#3a6a3a", "#b02818"][i % 4]);
  }
}

function drawSneezeGuard(ctx: CanvasRenderingContext2D) {
  rect(ctx, 62, 90, 196, 2, "#c8d0d8");
  rect(ctx, 62, 92, 196, 28, "#c0e8ff30");
  rect(ctx, 64, 92, 2, 28, "#a8b0b8");
  rect(ctx, 254, 92, 2, 28, "#a8b0b8");
  ctx.fillStyle = "#ffffff38";
  for (const x of [84, 92, 190]) {
    ctx.beginPath();
    ctx.moveTo(x, 92);
    ctx.lineTo(x + 6, 92);
    ctx.lineTo(x - 8, 120);
    ctx.lineTo(x - 14, 120);
    ctx.fill();
  }
}

function drawCounter(ctx: CanvasRenderingContext2D, bell: number) {
  rect(ctx, 0, COUNTER_Y, SCREEN_W, 8, "#d8b880");
  rect(ctx, 0, COUNTER_Y + 7, SCREEN_W, 1, "#8a6a3a");
  rect(ctx, 0, COUNTER_Y + 8, SCREEN_W, SCREEN_H - COUNTER_Y - 8, "#9aa2aa");
  for (let x = 6; x < SCREEN_W; x += 20) rect(ctx, x, COUNTER_Y + 8, 1, SCREEN_H, "#b8c0c8");
  // Register.
  rect(ctx, 14, 100, 34, 20, "#404850");
  rect(ctx, 18, 103, 26, 7, "#58d878");
  drawText(ctx, "0.00", 31, 103, "#103010", { align: "center" });
  // The bell.
  const hop = bell > 4 ? -2 : 0;
  rect(ctx, 264, 116, 18, 4, "#806020");
  ctx.fillStyle = "#f8c838";
  ctx.beginPath();
  ctx.arc(273, 116 + hop, 7, Math.PI, 0);
  ctx.fill();
  rect(ctx, 272, 106 + hop, 3, 3, "#f8c838");
  if (bell > 0) drawText(ctx, "!", 286, 100, "#f8d838");
}

function drawThrown(ctx: CanvasRenderingContext2D, thrown: Thrown, frame: number) {
  const k = Math.min(1, thrown.t / thrown.dur);
  const x = 184 - 24 * k;
  const y = 56 + 64 * k;
  const s = 1 + k * 3;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.rotate(thrown.kind === "coupon" || thrown.kind === "review" ? frame / 5 : 0);
  if (thrown.kind === "coupon") {
    rect(ctx, -6, -4, 12, 8, "#f8e070");
    rect(ctx, -5, -3, 10, 1, "#a08020");
    rect(ctx, -3, 0, 6, 1, "#a08020");
  } else if (thrown.kind === "review") {
    rect(ctx, -6, -4, 12, 8, "#fcfcfc");
    rect(ctx, -2, -2, 4, 4, "#f83818");
  } else {
    rect(ctx, -4, -3, 8, 6, "#f8f8f0");
    rect(ctx, -2, -5, 4, 10, "#f8f8f0");
    rect(ctx, 3, 1, 4, 2, "#f0f0e0");
  }
  ctx.restore();
}

/** The customer, waist at (0, 0) on the counter line. */
export function drawCustomer(ctx: CanvasRenderingContext2D, c: Customer, pose: Pose, t: number, frame: number, flash: boolean) {
  const S = c.colors;
  const skin = flash ? "#fcfcfc" : S.skin;
  const big = c.id === "hank" ? 1.15 : 1;
  ctx.save();
  ctx.scale(big, big);
  let hx = 0, hy = 0;
  if (pose === "windScream" || pose === "scream") hy = -3;
  if (pose === "windChoke") hy = -4;
  if (pose === "recover") hy = 3;
  if (pose === "ko") {
    hx = 8;
    hy = 30;
  }
  if (pose === "stuck") hy = 6;
  // Torso.
  rect(ctx, -24, -50, 48, 52, S.shirt);
  rect(ctx, -8, -50, 16, 4, "#00000030");
  if (c.id === "hank") drawText(ctx, "HANGRY", 0, -36, "#fcfcfc", { align: "center" });
  if (c.id === "carol") for (let i = -10; i <= 10; i += 4) rect(ctx, i, -48, 2, 2, "#f8f8f8");
  if (c.id === "randy") rect(ctx, -24, -50, 6, 52, "#2a4a2a");
  // Neck and head.
  rect(ctx, -5 + hx, -56 + hy, 10, 8, skin);
  if (pose !== "stuck") drawHead(ctx, c, hx, hy, pose, frame, skin);
  // Arms.
  const sh = { l: [-24, -46], r: [24, -46] } as const;
  const arm = (side: "l" | "r", x: number, y: number, holding?: string) => {
    const [sx, sy] = sh[side];
    limb(ctx, sx, sy, x, y, 9, S.shirt);
    rect(ctx, x - 5, y - 5, 10, 10, skin);
    if (holding === "coupon") rect(ctx, x - 7, y - 10, 12, 7, "#f8e070");
    if (holding === "ranch") {
      rect(ctx, x - 4, y - 16, 8, 12, "#f8f8f0");
      rect(ctx, x - 2, y - 20, 4, 4, "#58b838");
    }
    if (holding === "review") rect(ctx, x - 6, y - 12, 12, 8, "#fcfcfc");
  };
  const wobble = Math.round(Math.sin(frame / 6) * 2);
  switch (pose) {
    case "guard":
      arm("l", -12, -62 + wobble, undefined);
      arm("r", 12, -62 - wobble, undefined);
      break;
    case "windChoke":
      arm("l", -40, -96 + wobble, undefined);
      arm("r", 40, -96 - wobble, undefined);
      if (frame % 10 < 5) drawText(ctx, "!!", 0, -110, "#f83818", { align: "center", scale: 2 });
      break;
    case "choke":
    case "grab":
      arm("l", -16, 0, undefined);
      arm("r", 16, 0, undefined);
      break;
    case "windSlap":
      arm("l", -14, -60, undefined);
      arm("r", 44, -76, c.id === "carol" ? "coupon" : undefined);
      break;
    case "slap":
      arm("l", -14, -60, undefined);
      arm("r", -34, -40, c.id === "carol" ? "coupon" : undefined);
      for (let i = 0; i < 3; i++) rect(ctx, -10 + i * 12, -46 + i * 3, 10, 1, "#ffffff90");
      break;
    case "windThrow":
      arm("l", -20, -40, undefined);
      arm("r", 30, -100, c.throws);
      break;
    case "throw":
      arm("l", -20, -40, undefined);
      arm("r", 22, -60, undefined);
      break;
    case "windScream":
    case "scream":
      arm("l", -36, -20, undefined);
      arm("r", 36, -20, undefined);
      break;
    case "taunt":
      arm("l", -30, -12, undefined);
      arm("r", 18 + wobble, -82, undefined);
      break;
    case "recover":
      arm("l", -22, -6, undefined);
      arm("r", 22, -6, undefined);
      break;
    case "gloat":
      arm("l", -38, -84 + wobble, undefined);
      arm("r", 38, -84 - wobble, undefined);
      break;
    case "stuck":
      arm("l", -30, -24, undefined);
      arm("r", 30, -24, undefined);
      break;
    case "ko":
      arm("l", -30, -4, undefined);
      arm("r", 26, -4, undefined);
      for (let i = 0; i < 3; i++) {
        const zt = (t + i * 25) % 75;
        drawText(ctx, "Z", hx + 20 + zt / 4, hy - 80 - zt / 2, "#a4e4fc", { scale: 1 + (i === 1 ? 1 : 0) });
      }
      break;
  }
  ctx.restore();
}

function drawHead(ctx: CanvasRenderingContext2D, c: Customer, hx: number, hy: number, pose: Pose, frame: number, skin: string) {
  const S = c.colors;
  const x = hx - 13, y = hy - 84;
  rect(ctx, x, y, 26, 30, skin);
  rect(ctx, x - 2, y + 11, 2, 7, skin);
  rect(ctx, x + 26, y + 11, 2, 7, skin);
  // Hair and hats.
  if (c.id === "carol") {
    for (let i = 0; i < 6; i++) rect(ctx, x - 3 + i * 5, y - 5 + (i % 2) * 2, 7, 8, S.hair);
  } else if (c.id === "randy") {
    rect(ctx, x - 2, y - 4, 30, 9, S.accent);
    rect(ctx, x + 6, y - 3, 14, 6, "#fcfcfc");
    rect(ctx, x - 2, y + 4, 34, 3, S.accent);
  } else if (c.id === "karen") {
    rect(ctx, x - 3, y - 4, 32, 8, S.hair);
    rect(ctx, x - 4, y, 7, 24, S.hair);
    rect(ctx, x + 25, y, 4, 12, S.hair);
    rect(ctx, x + 3, y - 3, 20, 4, S.accent);
  } else {
    rect(ctx, x - 1, y - 3, 28, 6, S.hair);
    rect(ctx, x - 1, y + 19, 28, 12, S.hair); // beard
  }
  const angry = pose !== "ko" && pose !== "recover";
  // Eyes.
  if (pose === "ko") {
    rect(ctx, x + 5, y + 13, 6, 1, "#101010");
    rect(ctx, x + 15, y + 13, 6, 1, "#101010");
  } else {
    const red = pose === "windChoke" && frame % 8 < 4;
    rect(ctx, x + 5, y + 11, 6, 5, red ? "#f83818" : "#fcfcfc");
    rect(ctx, x + 15, y + 11, 6, 5, red ? "#f83818" : "#fcfcfc");
    rect(ctx, x + 8, y + 12, 2, 3, "#101010");
    rect(ctx, x + 16, y + 12, 2, 3, "#101010");
    if (angry) {
      limb(ctx, x + 5, y + 7, x + 11, y + 10, 2, c.id === "hank" ? S.hair : "#402010");
      limb(ctx, x + 21, y + 7, x + 15, y + 10, 2, c.id === "hank" ? S.hair : "#402010");
    }
  }
  if (c.id === "carol") {
    ctx.strokeStyle = "#202020";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 4.5, y + 10.5, 7, 6);
    ctx.strokeRect(x + 14.5, y + 10.5, 7, 6);
  }
  if (c.id === "randy") rect(ctx, x + 6, y + 20, 14, 3, S.hair); // mustache
  // Mouth.
  const yell = pose === "windScream" || pose === "scream" || pose === "taunt" || pose === "gloat" || pose === "windChoke" || pose === "choke" || pose === "grab";
  if (pose === "ko") {
    rect(ctx, x + 2, y + 21, 22, 6, "#e0b070"); // a sub, in the mouth, finally
    rect(ctx, x + 2, y + 24, 22, 1, "#58b838");
    rect(ctx, x + 2, y + 25, 22, 1, "#e83828");
  } else if (pose === "scream" || pose === "windScream") {
    rect(ctx, x + 7, y + 20, 12, 9, "#501010");
    rect(ctx, x + 8, y + 20, 10, 2, "#fcfcfc");
  } else if (yell && (frame % 12 < 6 || pose !== "taunt")) {
    rect(ctx, x + 8, y + 22, 10, 5, "#501010");
    rect(ctx, x + 9, y + 22, 8, 1, "#fcfcfc");
  } else {
    rect(ctx, x + 8, y + 23, 10, 2, "#701818");
  }
}

/** You, from behind, behind the counter. (x, y) shifts the whole body. */
function drawEmployee(ctx: CanvasRenderingContext2D, x: number, y: number, state: MeState, t: number, red: number) {
  const skin = red > 0 ? mix("#f0c090", "#e83828", red * 0.7) : "#f0c090";
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  // Shoulders and apron.
  rect(ctx, -32, 144, 64, 40, "#f4f4f4");
  rect(ctx, -32, 144, 64, 3, "#d8d8d8");
  rect(ctx, -3, 168, 6, 5, "#c8a060");
  limb(ctx, -3, 170, -12, 178, 2, "#c8a060");
  limb(ctx, 3, 170, 12, 178, 2, "#c8a060");
  rect(ctx, -14, 148, 2, 30, "#c8a060");
  rect(ctx, 12, 148, 2, 30, "#c8a060");
  // Neck, ears, back of the head.
  rect(ctx, -8, 136, 16, 10, skin);
  rect(ctx, -16, 122, 4, 9, skin);
  rect(ctx, 12, 122, 4, 9, skin);
  rect(ctx, -13, 110, 26, 30, "#5a3418");
  rect(ctx, -12, 132, 24, 6, "#4a2a12");
  // Paper deli hat.
  rect(ctx, -15, 104, 30, 10, "#fcfcfc");
  rect(ctx, -15, 108, 30, 2, "#d82800");
  if (red > 0.4) drawText(ctx, "!", 20, 100, "#f83818");
  // Arms: pickle in the left hand, sub in the right.
  const hand = (sx: number, ex: number, ey: number, item: "pickle" | "sub" | "jumbo" | null) => {
    limb(ctx, sx, 148, ex, ey, 10, "#f4f4f4");
    rect(ctx, ex - 5, ey - 5, 10, 10, skin);
    if (item === "pickle") {
      rect(ctx, ex - 3, ey - 13, 6, 10, "#58a828");
      rect(ctx, ex - 1, ey - 11, 1, 6, "#88d858");
    }
    if (item === "sub") {
      rect(ctx, ex - 10, ey - 10, 20, 7, "#e0b070");
      rect(ctx, ex - 10, ey - 6, 20, 1, "#58b838");
      rect(ctx, ex - 10, ey - 5, 20, 1, "#e83828");
    }
  };
  switch (state) {
    case "jab": {
      const k = Math.min(1, t / 5);
      hand(-26, -34 + 30 * k, 132 - 70 * k, "pickle");
      hand(26, 36, 132, "sub");
      break;
    }
    case "hook": {
      const k = Math.max(0, Math.min(1, (t - 6) / 9));
      hand(-26, -36, 132, "pickle");
      hand(26, 44 - 40 * k, 130 - 64 * k, "sub");
      break;
    }
    case "jumbo": {
      const k = Math.max(0, Math.min(1, (t - 8) / 14));
      const ey = 120 - 60 * k;
      hand(-26, -20, ey, null);
      hand(26, 20, ey, null);
      rect(ctx, -40, ey - 16, 80, 12, "#e0b070");
      rect(ctx, -40, ey - 9, 80, 2, "#58b838");
      rect(ctx, -40, ey - 7, 80, 2, "#e83828");
      rect(ctx, -40, ey - 5, 80, 1, "#f8e070");
      break;
    }
    case "grabbed":
      hand(-26, -10, 126 + (t % 8 < 4 ? -2 : 2), "pickle");
      hand(26, 10, 126 + (t % 8 < 4 ? 2 : -2), "sub");
      break;
    case "duck":
      hand(-26, -30, 120, "pickle");
      hand(26, 30, 120, "sub");
      break;
    default:
      hand(-26, -36, 132, "pickle");
      hand(26, 36, 132, "sub");
  }
  ctx.restore();
}

function mix(a: string, b: string, k: number) {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * k).toString(16).padStart(2, "0"));
  return `#${c.join("")}`;
}
