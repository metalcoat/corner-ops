import { DeliManAudio } from "./audio";
import { MAX_HP, SCREEN_H, SCREEN_W, START_LIVES, TILE } from "./constants";
import { BOSSES, ROBOT_MASTERS, SELECT_GRID, type BossId, type WeaponId } from "./data";
import { Input } from "./input";
import { fullEnergy } from "./player";
import { clearSave, loadSave, weaponsFor, writeSave, type DeliManSave } from "./save";
import {
  drawBossIntro,
  drawEnding,
  drawGameOver,
  drawPause,
  drawSelect,
  drawTitle,
  drawWeaponGet,
  pauseLayout,
  SELECT_CELLS,
} from "./screens";
import { Stage } from "./stage";
import { randomComplaint } from "@/lib/games/complaints";

export type GameMode = "title" | "select" | "intro" | "stage" | "pause" | "weaponGet" | "gameOver" | "ending";

/** Top-level state machine: title → stage select → stage → weapon get → … */
export class Game {
  readonly input = new Input();
  readonly audio = new DeliManAudio();
  mode: GameMode = "title";
  t = 0;
  save: DeliManSave = { defeated: [], cleared: false };
  stage: Stage | null = null;
  bossId: BossId = "pothole";
  lives = START_LIVES;
  checkpoint = -1;
  energy = fullEnergy();
  weapon: WeaponId = "buster";
  collected = new Set<number>();
  cursor = 0;
  menu = 0;
  /** Weapon earned on the last victory (for the weapon-get screen). */
  earned: WeaponId | null = null;
  /** A customer complaint about the boss you just beat. Winning never stops them. */
  complaint = "";

  constructor() {
    this.save = loadSave();
    this.cursor = 0;
  }

  get owned() {
    return weaponsFor(this.save);
  }

  get finalUnlocked() {
    return ROBOT_MASTERS.every((id) => this.save.defeated.includes(id));
  }

  private setMode(mode: GameMode) {
    this.mode = mode;
    this.t = 0;
    this.menu = 0;
  }

  private confirm() {
    return this.input.pressed("start") || this.input.pressed("jump") || this.input.pressed("shoot");
  }

  update() {
    this.input.poll();
    this.t++;
    switch (this.mode) {
      case "title":
        return this.updateTitle();
      case "select":
        return this.updateSelect();
      case "intro":
        if (this.t > 30 && this.confirm()) this.startStage(true);
        else if (this.t > 230) this.startStage(true);
        return;
      case "stage":
        return this.updateStage();
      case "pause":
        return this.updatePause();
      case "weaponGet":
        if (this.t > 120 && this.confirm()) this.toSelect();
        return;
      case "gameOver":
        return this.updateGameOver();
      case "ending":
        if (this.t > 240 && this.confirm()) {
          this.audio.play("title");
          this.setMode("title");
        }
        return;
    }
  }

  private updateTitle() {
    if (this.t === 1) this.audio.play("title");
    const hasSave = this.save.defeated.length > 0;
    if (hasSave && (this.input.pressed("up") || this.input.pressed("down"))) {
      this.menu = this.menu ? 0 : 1;
      this.audio.sfx("move");
    }
    if (this.t > 10 && this.confirm()) {
      this.audio.sfx("select");
      if (hasSave && this.menu === 1) {
        clearSave();
        this.save = loadSave();
      }
      this.toSelect();
    }
  }

  toSelect() {
    this.stage = null;
    this.audio.play("select");
    const firstOpen = SELECT_GRID.findIndex((id) => id !== "margin" && !this.save.defeated.includes(id));
    this.cursor = this.finalUnlocked ? 4 : Math.max(0, firstOpen);
    this.setMode("select");
  }

  private selectable(index: number) {
    const id = SELECT_GRID[index];
    if (id === "margin") return this.finalUnlocked;
    return true;
  }

  private updateSelect() {
    const i = this.input;
    let { cursor } = this;
    const col = cursor % 3;
    const row = Math.floor(cursor / 3);
    if (i.pressed("left")) cursor = row * 3 + ((col + 2) % 3);
    if (i.pressed("right")) cursor = row * 3 + ((col + 1) % 3);
    if (i.pressed("up")) cursor = ((row + 2) % 3) * 3 + col;
    if (i.pressed("down")) cursor = ((row + 1) % 3) * 3 + col;
    if (cursor !== this.cursor) {
      this.cursor = cursor;
      this.audio.sfx("move");
    }
    if (this.t > 10 && this.confirm()) this.chooseCell(this.cursor);
  }

  private chooseCell(index: number) {
    if (!this.selectable(index)) {
      this.audio.sfx("tink");
      return;
    }
    this.bossId = SELECT_GRID[index];
    this.audio.sfx("select");
    this.lives = Math.max(this.lives, START_LIVES);
    this.checkpoint = -1;
    this.energy = fullEnergy();
    this.weapon = "buster";
    this.collected = new Set();
    this.audio.stopMusic();
    this.setMode("intro");
  }

  startStage(fresh = false) {
    if (fresh) this.audio.sfx("ready");
    this.stage = new Stage(BOSSES[this.bossId], {
      checkpoint: this.checkpoint,
      energy: this.energy,
      weapon: this.owned.includes(this.weapon) ? this.weapon : "buster",
      lives: this.lives,
      collected: this.collected,
      audio: this.audio,
    });
    this.stage.ownedWeapons = this.owned;
    this.setMode("stage");
  }

  private cycleWeapon(dir: 1 | -1) {
    const stage = this.stage;
    if (!stage) return;
    const owned = this.owned;
    if (owned.length < 2) return;
    const index = owned.indexOf(stage.player.weapon);
    stage.player.weapon = owned[(index + dir + owned.length) % owned.length];
    stage.player.charge = 0;
    stage.shots = stage.shots.filter((s) => s.weapon === stage.player.weapon);
    this.weapon = stage.player.weapon;
    this.audio.sfx("weapon");
  }

  private updateStage() {
    const stage = this.stage!;
    if (stage.mode === "play" && this.input.pressed("start")) {
      this.audio.sfx("pause");
      this.mode = "pause";
      this.menu = Math.max(0, this.owned.indexOf(stage.player.weapon));
      return;
    }
    if (stage.mode === "play" && stage.player.state !== "dead") {
      if (this.input.pressed("next")) this.cycleWeapon(1);
      if (this.input.pressed("prev")) this.cycleWeapon(-1);
    }
    stage.update(this.input);
    this.lives = stage.lives;
    this.checkpoint = stage.checkpoint;
    this.weapon = stage.player.weapon;
    if (stage.result === "dead") {
      this.lives--;
      if (this.lives < 0) {
        this.audio.play("gameOver");
        this.setMode("gameOver");
      } else this.startStage();
    } else if (stage.result === "victory") {
      const def = BOSSES[this.bossId];
      this.complaint = randomComplaint();
      this.save = { ...this.save, defeated: [...new Set([...this.save.defeated, this.bossId])] };
      if (this.bossId === "margin") this.save.cleared = true;
      writeSave(this.save);
      this.stage = null;
      if (this.bossId === "margin" || !def.weapon) {
        this.audio.play("title");
        this.setMode("ending");
      } else {
        this.earned = def.weapon;
        this.weapon = def.weapon;
        this.audio.play("weaponGet");
        this.setMode("weaponGet");
      }
    }
  }

  /** Pause menu rows: owned weapons, then EXIT. */
  pauseRows() {
    return [...this.owned, "exit" as const];
  }

  private updatePause() {
    const rows = this.pauseRows();
    if (this.input.pressed("down") || this.input.pressed("right") || this.input.pressed("next")) {
      this.menu = (this.menu + 1) % rows.length;
      this.audio.sfx("move");
    }
    if (this.input.pressed("up") || this.input.pressed("left") || this.input.pressed("prev")) {
      this.menu = (this.menu + rows.length - 1) % rows.length;
      this.audio.sfx("move");
    }
    if (this.confirm()) this.choosePause(this.menu);
  }

  /** Auto-pause when the tab is hidden. */
  pauseIfPlaying() {
    if (this.mode === "stage" && this.stage?.mode === "play") {
      this.mode = "pause";
      this.menu = Math.max(0, this.owned.indexOf(this.stage.player.weapon));
    }
    this.input.clear();
  }

  private choosePause(index: number) {
    const stage = this.stage!;
    const row = this.pauseRows()[index];
    if (row === "exit") {
      this.audio.sfx("select");
      this.toSelect();
      return;
    }
    if (stage.player.weapon !== row) {
      stage.player.weapon = row;
      stage.player.charge = 0;
      stage.shots = [];
      this.weapon = row;
    }
    this.audio.sfx("pause");
    this.mode = "stage";
    this.input.clear();
  }

  private updateGameOver() {
    if (this.input.pressed("up") || this.input.pressed("down")) {
      this.menu = this.menu ? 0 : 1;
      this.audio.sfx("move");
    }
    if (this.t > 30 && this.confirm()) this.chooseGameOver(this.menu);
  }

  private chooseGameOver(index: number) {
    this.audio.sfx("select");
    this.lives = START_LIVES;
    if (index === 0) {
      this.energy = fullEnergy();
      this.startStage(true);
    } else this.toSelect();
  }

  /** Pointer/tap support for menus, in native 256x240 coordinates. */
  tap(x: number, y: number) {
    this.audio.unlock();
    switch (this.mode) {
      case "title":
        if (this.t > 10) {
          if (this.save.defeated.length > 0 && y > 150 && y < 186) this.menu = y < 168 ? 0 : 1;
          this.input.setTouch("start", true);
          setTimeout(() => this.input.setTouch("start", false), 50);
        }
        return;
      case "select": {
        const index = SELECT_CELLS.findIndex((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
        if (index < 0) return;
        if (index === this.cursor) this.chooseCell(index);
        else {
          this.cursor = index;
          this.audio.sfx("move");
        }
        return;
      }
      case "pause": {
        const rows = this.pauseRows();
        const index = Math.floor((y - pauseLayout(rows.length).top - 20) / 16);
        if (index >= 0 && index < rows.length) this.choosePause(index);
        return;
      }
      case "gameOver":
        if (this.t > 30 && y > 120 && y < 168) this.chooseGameOver(y < 144 ? 0 : 1);
        return;
      case "weaponGet":
      case "ending":
      case "intro":
        this.input.setTouch("start", true);
        setTimeout(() => this.input.setTouch("start", false), 50);
        return;
    }
  }

  render(ctx: CanvasRenderingContext2D) {
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    switch (this.mode) {
      case "title":
        drawTitle(ctx, this);
        break;
      case "select":
        drawSelect(ctx, this);
        break;
      case "intro":
        drawBossIntro(ctx, this);
        break;
      case "stage":
        this.stage?.render(ctx, { lives: this.lives });
        break;
      case "pause":
        this.stage?.render(ctx, { lives: this.lives });
        drawPause(ctx, this);
        break;
      case "weaponGet":
        drawWeaponGet(ctx, this);
        break;
      case "gameOver":
        drawGameOver(ctx, this);
        break;
      case "ending":
        drawEnding(ctx, this);
        break;
    }
  }

  /* ---- development helpers (exposed on window in dev builds only) ---- */

  debugBoss(id: BossId) {
    this.bossId = id;
    this.checkpoint = -1;
    this.energy = fullEnergy();
    this.collected = new Set();
    this.startStage(true);
    const stage = this.stage!;
    stage.mode = "play";
    stage.player.x = stage.level.doorCol * TILE - 40;
    stage.player.y = 12 * TILE - 22;
    stage.camX = Math.max(0, (stage.level.doorCol + 1) * TILE - SCREEN_W);
  }

  debugGrant(ids: BossId[]) {
    this.save = { ...this.save, defeated: [...new Set([...this.save.defeated, ...ids])] };
    writeSave(this.save);
  }

  debugHurtBoss(amount = MAX_HP) {
    const boss = this.stage?.boss;
    if (boss) boss.hp = Math.max(1, boss.hp - amount);
  }
}
