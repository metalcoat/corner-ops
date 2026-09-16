"use client";
import { useEffect, useRef, useState } from "react";
import type Phaser from "phaser";
import { BOSSES, STAGES } from "@/lib/games/deli-man-data";
import {
  buildStageRooms,
  completeDeliManStage,
  loadDeliManSave,
  type DeliManSave,
} from "@/lib/games/deli-man-campaign";
import { getDeliManArt } from "@/lib/games/deli-man-art";
import {
  createDeliManTextures,
  renderDeliManStage,
} from "@/lib/games/deli-man-renderer";
export default function DeliMan() {
  const host = useRef<HTMLDivElement>(null),
    game = useRef<Phaser.Game | null>(null),
    touch = useRef({
      left: false,
      right: false,
      jump: false,
      jumpPressed: false,
      fire: false,
      fireHeld: false,
      fireReleased: false,
      dashPressed: false,
      mapPressed: false,
    });
  const [stage, setStage] = useState<number | null>(null),
    [sound, setSound] = useState(true),
    [progress, setProgress] = useState<DeliManSave | null>(null);
  useEffect(() => {
    const sync = () => setProgress(loadDeliManSave());
    sync();
    window.addEventListener("deli-man-save", sync);
    return () => window.removeEventListener("deli-man-save", sync);
  }, []);
  useEffect(() => {
    if (stage === null || !host.current) return;
    const stageIndex = stage;
    let alive = true;
    let instance: Phaser.Game | null = null;
    void import("phaser").then((P) => {
      if (!alive || !host.current) return;
      const def = STAGES[stageIndex];
      const art = getDeliManArt(def.id);
      const bossProfile = def.bossId ? BOSSES[def.bossId] : null;
      const developerMode =
        window.location.hostname.startsWith("dev.") ||
        process.env.NODE_ENV !== "production";
      class Scene extends P.Scene {
        player!: Phaser.Physics.Arcade.Sprite;
        cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
        keys!: Record<string, Phaser.Input.Keyboard.Key>;
        enemies!: Phaser.Physics.Arcade.Group;
        shots!: Phaser.Physics.Arcade.Group;
        tip!: Phaser.GameObjects.Text;
        hp = 8;
        score = 0;
        distance = 0;
        boss = bossProfile?.health ?? 12 + stageIndex * 3;
        checkpoint = 0;
        invuln = 0;
        facing = 1;
        bossActive = false;
        bossDefeated = false;
        lastGroundedAt = 0;
        jumpQueuedAt = 0;
        lastShotAt = 0;
        chargeStartedAt = 0;
        dashUntil = 0;
        dashCooldownUntil = 0;
        respawnX = 100;
        controlLockedUntil = 0;
        cameraFurthestX = 0;
        gameState:
          | "PLAYING"
          | "BOSS_INTRO"
          | "BOSS_FIGHT"
          | "BOSS_DEFEATED"
          | "REWARD"
          | "COMPLETE" = "PLAYING";
        stateStartedAt = 0;
        levelCompleteQueued = false;
        lastLoopErrorAt = -5000;
        debugVisible = false;
        debugText!: Phaser.GameObjects.Text;
        bossWarning!: Phaser.GameObjects.Text;
        mapOverlay!: Phaser.GameObjects.Container;
        mapVisible = false;
        visitedRooms = new Set<string>();
        bossGate!: Phaser.Physics.Arcade.StaticGroup;
        entranceGate!: Phaser.GameObjects.Rectangle;
        playerState:
          | "grounded"
          | "run"
          | "airborne"
          | "wall_slide"
          | "dashing"
          | "climbing"
          | "hurt"
          | "dead" = "grounded";
        bossSprite!: Phaser.Physics.Arcade.Sprite;
        exitDoor!: Phaser.GameObjects.Rectangle;
        ladders: Array<{ x: number; top: number; bottom: number }> = [];
        preload() {
          this.load.image("stage-backdrop", art.background);
        }
        create() {
          console.info("[DELI MAN] LEVEL START", {
            level: def.id,
            location: def.location,
          });
          this.cameras.main.setBackgroundColor(def.theme);
          this.cameras.main.setRoundPixels(true);
          const authoredRoutes = [
            { x: 720, top: 420, width: 300 },
            { x: 1740, top: 350, width: 360 },
            { x: 2860, top: 430, width: 330 },
            { x: 4020, top: 330, width: 390 },
          ];
          const g = renderDeliManStage(this, art, authoredRoutes);
          /* Northern NY street scenery is reserved for Delivery Route 666.
             Other stages now use their own art-directed backdrop and props. */
          if (art.prop === "street") {
            const buildings = [
              {
                x: 250,
                w: 360,
                h: 205,
                color: 0x7e553e,
                roof: 0x3b2924,
                kind: "duplex",
                sign: "+59% TAX\nINCREASE",
              },
              {
                x: 760,
                w: 300,
                h: 255,
                color: 0xb89b72,
                roof: 0x49352c,
                kind: "church",
                sign: "ROOF FUND\nSTILL PENDING",
              },
              {
                x: 1240,
                w: 430,
                h: 180,
                color: 0x6f7c80,
                roof: 0x292d30,
                kind: "row",
                sign: "GREG STILL\nHAS THE KEYS",
              },
              {
                x: 1880,
                w: 340,
                h: 235,
                color: 0x8f5b45,
                roof: 0x43302a,
                kind: "roof",
                sign: "NEW ROOF\nEST. 2029",
              },
              {
                x: 2420,
                w: 460,
                h: 195,
                color: 0x596d73,
                roof: 0x272f31,
                kind: "dump",
                sign: "PORCH LOAD\nBEARING-ISH",
              },
              {
                x: 3080,
                w: 320,
                h: 265,
                color: 0xc4ad82,
                roof: 0x3d332c,
                kind: "church",
                sign: "POTHOLE VIEW\nAPARTMENTS",
              },
              {
                x: 3600,
                w: 420,
                h: 215,
                color: 0x73513f,
                roof: 0x332720,
                kind: "roof",
                sign: "CITY VALUE ↑\nROOF VALUE ?",
              },
            ];
            buildings.forEach((b, i) => {
              const y = 610 - b.h;
              g.fillStyle(b.color).fillRect(b.x, y, b.w, b.h);
              if (b.kind === "church") {
                g.fillStyle(b.roof).fillTriangle(
                  b.x - 20,
                  y,
                  b.x + b.w / 2,
                  y - 125,
                  b.x + b.w + 20,
                  y,
                );
                g.fillStyle(0xd5c59e).fillRect(
                  b.x + b.w / 2 - 17,
                  y - 170,
                  34,
                  80,
                );
                g.fillTriangle(
                  b.x + b.w / 2 - 28,
                  y - 170,
                  b.x + b.w / 2,
                  y - 225,
                  b.x + b.w / 2 + 28,
                  y - 170,
                );
              } else {
                g.fillStyle(b.roof).fillTriangle(
                  b.x - 20,
                  y,
                  b.x + b.w / 2,
                  y - 75 - (i % 2) * 25,
                  b.x + b.w + 20,
                  y,
                );
              }
              for (let wx = b.x + 35; wx < b.x + b.w - 35; wx += 92) {
                g.fillStyle(i % 2 ? 0x9bd2e6 : 0x99b5bf).fillRect(
                  wx,
                  y + 55,
                  42,
                  52,
                );
                g.lineStyle(3, 0x272727).strokeRect(wx, y + 55, 42, 52);
              }
              // Every destination door is at street/porch level, never on a roof.
              g.fillStyle(0x4b2519).fillRect(b.x + b.w - 82, 610 - 92, 54, 92);
              g.fillStyle(0xffd447).fillCircle(b.x + b.w - 40, 565, 5);
              if (b.kind === "roof") {
                g.fillStyle(0xf3a826).fillRect(b.x + 60, y - 45, 120, 12);
                g.fillStyle(0xf6d04d)
                  .fillCircle(b.x + 88, y - 55, 10)
                  .fillCircle(b.x + 150, y - 55, 10);
                this.add.text(
                  b.x + 45,
                  y - 92,
                  "ROOF CREW: 2 WORKING\n5 SUPERVISING",
                  {
                    fontFamily: "monospace",
                    fontSize: "12px",
                    color: "#fff36c",
                    backgroundColor: "#111d",
                  },
                );
              }
              this.add.text(b.x + 12, 574, b.sign, {
                fontFamily: "monospace",
                fontSize: "13px",
                color: "#ffec60",
                backgroundColor: "#651b16dd",
                padding: { x: 5, y: 3 },
              });
            });
          }
          const collisionTexture = this.make.graphics({ x: 0, y: 0 }, false);
          collisionTexture.fillStyle(0xffffff, 0.001).fillRect(0, 0, 8, 8);
          collisionTexture.generateTexture("ground", 8, 8);
          collisionTexture.destroy();
          this.physics.world.setBounds(0, 0, 5000, 720);
          const ground = this.physics.add.staticGroup();
          ground
            .create(2500, 650)
            .setDisplaySize(5000, 80)
            .setVisible(false)
            .refreshBody();
          const platforms = this.physics.add.staticGroup();
          authoredRoutes.forEach((route) => {
            this.ladders.push({ x: route.x, top: route.top, bottom: 610 });
            platforms
              .create(route.x + route.width / 2 - 18, route.top, "ground")
              .setDisplaySize(route.width, 24)
              .setVisible(false)
              .refreshBody();
          });
          createDeliManTextures(this, art);
          const makePerson = (key: string, shirt: number, hat = false) => {
            const p = this.make.graphics({ x: 0, y: 0 }, false);
            p.fillStyle(0x15131a)
              .fillCircle(23, 15, 14)
              .fillRect(6, 26, 34, 34);
            if (hat)
              p.fillStyle(0xf0ad20)
                .fillRect(7, 0, 32, 9)
                .fillRect(13, 7, 31, 5);
            p.fillStyle(0xb87548).fillCircle(23, 16, 11);
            p.fillStyle(0xf4cfac).fillRect(15, 11, 13, 4);
            p.fillStyle(0x111111).fillRect(28, 16, 3, 3);
            p.fillStyle(shirt).fillRect(8, 27, 30, 31);
            p.fillStyle(shadeColor(shirt, 42)).fillRect(11, 29, 21, 6);
            p.fillStyle(0xb87548)
              .fillRect(2, 31, 7, 24)
              .fillRect(38, 31, 7, 24);
            p.fillStyle(0x172432)
              .fillRect(8, 56, 12, 24)
              .fillRect(27, 56, 12, 24);
            p.fillStyle(0x1b1110)
              .fillRect(4, 76, 18, 7)
              .fillRect(25, 76, 18, 7);
            p.generateTexture(key, 46, 84);
            p.destroy();
          };
          const shadeColor = (color: number, amount: number) => {
            const r = Math.min(255, (color >> 16) + amount);
            const gg = Math.min(255, ((color >> 8) & 255) + amount);
            const b = Math.min(255, (color & 255) + amount);
            return (r << 16) | (gg << 8) | b;
          };
          makePerson("roofer", 0xf08324, true);
          makePerson("customer", 0x7d45a8);
          makePerson("pedestrian", 0x3a78a8);
          const pizzaShot = this.make.graphics({ x: 0, y: 0 }, false);
          pizzaShot.fillStyle(0xd89a43).fillCircle(12, 12, 11);
          pizzaShot.fillStyle(0xf2cf5b).fillCircle(12, 12, 8);
          pizzaShot
            .fillStyle(0xc9382e)
            .fillCircle(8, 8, 2)
            .fillCircle(16, 11, 2)
            .fillCircle(11, 17, 2);
          pizzaShot.lineStyle(2, 0xffe28a).strokeCircle(12, 12, 10);
          pizzaShot.generateTexture("pizza-shot", 24, 24);
          pizzaShot.destroy();
          this.player = this.physics.add
            .sprite(100, 560, "hero-idle")
            .setCollideWorldBounds(true);
          this.player.body!.setSize(34, 56);
          this.cameras.main.setBounds(0, 0, 5000, 720);
          this.cursors = this.input.keyboard!.createCursorKeys();
          this.keys = this.input.keyboard!.addKeys(
            "W,A,S,D,X,F,SHIFT,ESC",
          ) as Record<string, Phaser.Input.Keyboard.Key>;
          this.enemies = this.physics.add.group();
          this.shots = this.physics.add.group();
          for (let x = 520; x < 4300; x += 330 - stageIndex * 15) {
            const e = this.enemies.create(
              x,
              570,
              "enemy",
            ) as Phaser.Physics.Arcade.Sprite;
            e.setData(
              "name",
              def.hazards[Math.floor(Math.random() * def.hazards.length)],
            );
            e.setData("patrolSpeed", 45 + stageIndex * 8);
            this.add.text(x - 26, 515, String(e.getData("name")), {
              fontFamily: "monospace",
              fontSize: "10px",
              color: "#ffef73",
              backgroundColor: "#111c",
            });
            e.setVelocityX(-45 - stageIndex * 8)
              .setCollideWorldBounds(true)
              .setBounce(1, 0);
            this.tweens.add({
              targets: e,
              scaleY: 0.9,
              duration: 180,
              yoyo: true,
              repeat: -1,
            });
          }
          this.bossSprite = this.physics.add
            .sprite(4680, 530, "boss")
            .setImmovable(true)
            .setVisible(false);
          this.bossSprite.disableBody(false, false);
          this.entranceGate = this.add
            .rectangle(4475, 500, 28, 220, 0xc83a2c)
            .setStrokeStyle(4, 0xffd438)
            .setVisible(false);
          this.physics.add.existing(this.entranceGate, true);
          (this.entranceGate.body as Phaser.Physics.Arcade.StaticBody).enable =
            false;
          this.exitDoor = this.add
            .rectangle(4925, 535, 72, 150, 0x163f27)
            .setStrokeStyle(6, 0x73ff86)
            .setVisible(false);
          [1010, 2140, 3360].forEach((x, i) => {
            const npc = this.add.sprite(
              x,
              560,
              i === 0 ? "roofer" : i === 1 ? "customer" : "pedestrian",
            );
            this.tweens.add({
              targets: npc,
              y: 555,
              duration: 420 + i * 80,
              yoyo: true,
              repeat: -1,
            });
          });
          const pickups = this.physics.add.staticGroup();
          [
            { x: 640, y: 500 },
            ...authoredRoutes.map((route) => ({
              x: route.x + route.width - 70,
              y: route.top - 45,
            })),
          ].forEach(({ x, y }) => {
            const coin = this.add
              .circle(x, y, 11, 0xffd438)
              .setStrokeStyle(3, 0xffffff);
            pickups.add(coin);
            this.tweens.add({
              targets: coin,
              y: y - 14,
              duration: 500,
              yoyo: true,
              repeat: -1,
            });
          });
          this.physics.add.overlap(this.player, pickups, (_, item) => {
            item.destroy();
            this.score += 50;
          });
          this.physics.add.collider(this.player, this.enemies, () =>
            this.damage(),
          );
          this.physics.add.overlap(this.shots, this.enemies, (a, b) => {
            const enemy = b as Phaser.Physics.Arcade.Sprite;
            this.impactBurst(enemy.x, enemy.y, art.accent);
            a.destroy();
            b.destroy();
            this.score += 100;
          });
          this.physics.add.overlap(this.shots, this.bossSprite, (a, b) => {
            const shot = (a === this.bossSprite ? b : a) as
              Phaser.Physics.Arcade.Sprite | undefined;
            const shotDamage = Math.max(
              1,
              Number(shot?.getData("damage")) || 1,
            );
            if (shot?.active) shot.destroy();
            if (this.gameState !== "BOSS_FIGHT" || this.bossDefeated) return;
            this.boss -= shotDamage;
            this.impactBurst(this.bossSprite.x, this.bossSprite.y, art.glow);
            this.bossSprite.setTint(0xffffff);
            this.time.delayedCall(70, () => this.bossSprite.clearTint());
            if (this.boss <= 0) {
              this.bossDefeated = true;
              this.setGameState("BOSS_DEFEATED");
              this.bossSprite.disableBody(true, true);
              this.score += 2500;
            }
          });
          this.physics.add.collider(this.player, ground);
          this.physics.add.collider(this.enemies, ground);
          this.physics.add.collider(this.enemies, platforms);
          this.physics.add.collider(this.bossSprite, ground);
          this.physics.add.collider(this.player, platforms, undefined, () => {
            const climbingUp =
              this.cursors?.up.isDown ||
              this.keys?.W.isDown ||
              touch.current.jump;
            const route = this.ladders.find(
              (ladder) =>
                Math.abs(this.player.x - ladder.x - 24) < 50 &&
                this.player.y > ladder.top,
            );
            return !(climbingUp && route);
          });
          this.physics.add.collider(this.player, this.entranceGate);
          this.tip = this.add
            .text(16, 16, "", {
              fontFamily: "monospace",
              fontSize: "18px",
              color: "#fff",
              backgroundColor: "#000c",
              padding: { x: 10, y: 8 },
            })
            .setScrollFactor(0)
            .setDepth(20);
          this.debugText = this.add
            .text(16, 112, "", {
              fontFamily: "monospace",
              fontSize: "13px",
              color: "#73ff86",
              backgroundColor: "#000d",
              padding: { x: 8, y: 6 },
            })
            .setScrollFactor(0)
            .setDepth(100)
            .setVisible(false);
          this.createMapOverlay();
          this.bossWarning = this.add
            .text(640, 260, "", {
              fontFamily: "monospace",
              fontSize: "44px",
              fontStyle: "bold",
              align: "center",
              color: "#fff6b0",
              stroke: "#35040b",
              strokeThickness: 10,
              backgroundColor: "#9f122be8",
              padding: { x: 38, y: 20 },
            })
            .setOrigin(0.5)
            .setScrollFactor(0)
            .setDepth(90)
            .setVisible(false);
          const stageIntro = this.add
            .text(
              640,
              300,
              `STAGE ${stageIndex + 1}\n${def.name}\n\nBOSS: ${def.boss}`,
              {
                fontFamily: "monospace",
                fontSize: "36px",
                fontStyle: "bold",
                align: "center",
                color: "#ffffff",
                stroke: "#080b13",
                strokeThickness: 9,
                backgroundColor: "#08111ee8",
                padding: { x: 42, y: 26 },
              },
            )
            .setOrigin(0.5)
            .setScrollFactor(0)
            .setDepth(85);
          this.tweens.add({
            targets: stageIntro,
            alpha: 0,
            y: 280,
            delay: 850,
            duration: 360,
            onComplete: () => stageIntro.destroy(),
          });
          this.add
            .text(100, 120, `${def.location}\n\n${def.intro}`, {
              fontFamily: "monospace",
              fontSize: "24px",
              align: "center",
              color: "#fff",
            })
            .setOrigin(0);
          def.lines.forEach((l, i) =>
            this.add.text(900 + i * 1050, 420, l, {
              fontFamily: "monospace",
              fontSize: "18px",
              color: "#ffe36a",
              backgroundColor: "#111d",
              padding: { x: 8, y: 6 },
            }),
          );
          const beginCharge = () => {
            if (!this.chargeStartedAt) this.chargeStartedAt = this.time.now;
          };
          const releaseCharge = () => {
            if (!this.chargeStartedAt) return;
            this.fire(this.time.now - this.chargeStartedAt >= 650);
            this.chargeStartedAt = 0;
          };
          this.input.keyboard!.on("keydown-X", beginCharge);
          this.input.keyboard!.on("keydown-F", beginCharge);
          this.input.keyboard!.on("keyup-X", releaseCharge);
          this.input.keyboard!.on("keyup-F", releaseCharge);
          this.input.keyboard!.on("keydown-SHIFT", () => this.dash());
          this.input.keyboard!.on("keydown-ESC", () => this.toggleMap());
          this.input.keyboard!.on(
            "keydown-UP",
            () => (this.jumpQueuedAt = this.time.now),
          );
          this.input.keyboard!.on(
            "keydown-W",
            () => (this.jumpQueuedAt = this.time.now),
          );
          this.input.keyboard!.on("keyup-UP", () => this.cutJump());
          this.input.keyboard!.on("keyup-W", () => this.cutJump());
          this.input.keyboard!.on("keydown-BACKTICK", () => {
            if (!developerMode) return;
            this.debugVisible = !this.debugVisible;
            this.debugText.setVisible(this.debugVisible);
          });
          this.input.keyboard!.on("keydown-B", () => {
            if (developerMode) this.player.setPosition(4560, 520);
          });
          this.input.keyboard!.on("keydown-K", () => {
            if (developerMode && this.gameState === "BOSS_FIGHT") this.boss = 1;
          });
          this.input.keyboard!.on("keydown-H", () => {
            if (developerMode && this.gameState === "BOSS_FIGHT") {
              this.hp = 1;
              this.damage();
            }
          });
          this.input.keyboard!.on("keydown", (event: KeyboardEvent) => {
            if (!developerMode) return;
            const destination = Number(event.key) - 1;
            if (destination >= 0 && destination < STAGES.length) {
              console.info("[DELI MAN] DEV LEVEL JUMP", {
                from: def.id,
                to: STAGES[destination].id,
              });
              setStage(destination);
            }
          });
          if (developerMode)
            (
              window as typeof window & {
                __DELI_MAN_DEBUG__?: () => Record<string, unknown>;
              }
            ).__DELI_MAN_DEBUG__ = () => ({
              level: def.id,
              fps: Math.round(this.game.loop.actualFps),
              gameState: this.gameState,
              player: { x: this.player.x, y: this.player.y, hp: this.hp },
              velocity: {
                x: (this.player.body as Phaser.Physics.Arcade.Body).velocity.x,
                y: (this.player.body as Phaser.Physics.Arcade.Body).velocity.y,
              },
              blocked: {
                left: (this.player.body as Phaser.Physics.Arcade.Body).blocked
                  .left,
                right: (this.player.body as Phaser.Physics.Arcade.Body).blocked
                  .right,
                down: (this.player.body as Phaser.Physics.Arcade.Body).blocked
                  .down,
              },
              cameraX: this.cameras.main.scrollX,
              enemies: this.enemies.countActive(true),
              displayObjects: this.children.list.length,
              activeTweens: this.tweens.getTweens().length,
              bossHealth: this.boss,
              projectiles: this.shots.countActive(true),
            });
          this.input.gamepad?.once("connected", () => {});
          this.input.on("pointerdown", (p: Phaser.Input.Pointer) =>
            p.x > this.scale.width * 0.55 ? this.fire() : this.jump(),
          );
        }
        jump() {
          if (this.time.now - this.lastGroundedAt < 125)
            this.player.setVelocityY(-520);
        }
        createMapOverlay() {
          const rooms = buildStageRooms(def.id);
          const panel = this.add
            .rectangle(640, 360, 840, 430, 0x07101d, 0.97)
            .setStrokeStyle(6, 0x8dd8e8);
          const title = this.add
            .text(640, 185, `${def.name}\nSERVICE MAP`, {
              fontFamily: "monospace",
              fontSize: "26px",
              fontStyle: "bold",
              align: "center",
              color: "#fff5a8",
            })
            .setOrigin(0.5);
          const parts: Phaser.GameObjects.GameObject[] = [panel, title];
          rooms.forEach((room) => {
            const x = 385 + room.column * 130;
            const y = 315 + room.row * 92;
            room.exits.forEach((exitId) => {
              const exit = rooms.find((candidate) => candidate.id === exitId);
              if (!exit || exit.column < room.column) return;
              parts.push(
                this.add
                  .rectangle(
                    (x + (385 + exit.column * 130)) / 2,
                    (y + (315 + exit.row * 92)) / 2,
                    Math.max(8, Math.abs(exit.column - room.column) * 130),
                    5,
                    0x44768b,
                  )
                  .setAngle(exit.row === room.row ? 0 : -35),
              );
            });
            const discovered = room.kind !== "secret";
            const box = this.add
              .rectangle(x, y, 104, 54, discovered ? 0x183b55 : 0x111923)
              .setStrokeStyle(3, room.kind === "boss" ? 0xff5a4c : 0x8dd8e8)
              .setData("roomId", room.id);
            const label = this.add
              .text(x, y, discovered ? room.name : "?", {
                fontFamily: "monospace",
                fontSize: "11px",
                align: "center",
                color: discovered ? "#ffffff" : "#65727e",
              })
              .setOrigin(0.5)
              .setData("roomLabel", room.id);
            parts.push(box, label);
          });
          parts.push(
            this.add
              .text(640, 535, "ESC / MAP TO RETURN · VISITED ROOMS LIGHT UP", {
                fontFamily: "monospace",
                fontSize: "15px",
                color: "#9fffb4",
              })
              .setOrigin(0.5),
          );
          this.mapOverlay = this.add
            .container(0, 0, parts)
            .setScrollFactor(0)
            .setDepth(200)
            .setVisible(false);
        }
        toggleMap() {
          this.mapVisible = !this.mapVisible;
          this.mapOverlay.setVisible(this.mapVisible);
          if (this.mapVisible) this.player.setVelocity(0, 0);
        }
        cutJump() {
          const body = this.player.body as Phaser.Physics.Arcade.Body;
          if (body.velocity.y < 0) this.player.setVelocityY(0);
        }
        fire(charged = false) {
          if (this.time.now - this.lastShotAt < 175) return;
          if (this.shots.countActive(true) >= 3) return;
          this.lastShotAt = this.time.now;
          const b = this.shots.create(
            this.player.x + this.facing * 32,
            this.player.y,
            "pizza-shot",
          ) as Phaser.Physics.Arcade.Sprite;
          b.setVelocityX(this.facing * 620);
          (b.body as Phaser.Physics.Arcade.Body).setAllowGravity(false);
          b.setAngularVelocity(this.facing * 720);
          b.setData("bornAt", this.time.now);
          b.setData("damage", charged ? 3 : 1);
          if (charged) {
            b.setScale(1.65);
            b.setTint(0xffef72);
            this.cameras.main.flash(55, 255, 210, 70, false);
          }
        }
        dash() {
          const body = this.player.body as Phaser.Physics.Arcade.Body;
          if (
            this.time.now < this.dashCooldownUntil ||
            this.time.now < this.controlLockedUntil ||
            !body.blocked.down
          )
            return;
          this.dashUntil = this.time.now + 210;
          this.dashCooldownUntil = this.time.now + 480;
          this.playerState = "dashing";
          this.player.setVelocityX(this.facing * 465);
        }
        impactBurst(x: number, y: number, color: number) {
          for (let i = 0; i < 9; i++) {
            const spark = this.add
              .rectangle(x, y, 4 + (i % 3) * 2, 4, i % 2 ? color : 0xffffff)
              .setDepth(15)
              .setAngle(i * 40);
            this.tweens.add({
              targets: spark,
              x: x + Math.cos((i / 9) * Math.PI * 2) * (34 + (i % 3) * 8),
              y: y + Math.sin((i / 9) * Math.PI * 2) * (28 + (i % 2) * 7),
              alpha: 0,
              scale: 0.3,
              duration: 220,
              onComplete: () => spark.destroy(),
            });
          }
        }
        damage() {
          if (this.time.now < this.invuln) return;
          this.invuln = this.time.now + 1500;
          this.controlLockedUntil = this.time.now + 320;
          this.playerState = "hurt";
          this.hp--;
          this.player.setTint(0xffffff).setVelocity(-this.facing * 260, -300);
          this.tweens.add({
            targets: this.player,
            alpha: 0.12,
            duration: 65,
            yoyo: true,
            repeat: 10,
            onComplete: () => this.player.setAlpha(1).clearTint(),
          });
          if (this.hp <= 0) {
            this.hp = 8;
            this.player
              .setPosition(this.bossActive ? 4520 : this.respawnX, 540)
              .setVelocity(0, 0);
            if (this.bossActive) {
              this.boss = bossProfile?.health ?? 12 + stageIndex * 3;
              this.bossDefeated = false;
              this.bossSprite
                .enableBody(true, 4680, 530, true, true)
                .setVelocity(0, 0);
              this.bossSprite.disableBody(false, false);
              this.setGameState("BOSS_INTRO");
            }
          }
        }
        setGameState(next: typeof this.gameState) {
          if (this.gameState === next) return;
          this.gameState = next;
          this.stateStartedAt = this.time.now;
          if (developerMode)
            console.info(`[DELI MAN] ${next.replaceAll("_", " ")}`, {
              level: def.id,
              boss: bossProfile?.name ?? def.boss,
            });
        }
        completeLevel() {
          if (this.levelCompleteQueued) return;
          this.levelCompleteQueued = true;
          this.setGameState("COMPLETE");
          completeDeliManStage(def.id, def.ability, this.score);
          Promise.resolve().then(() => {
            if (!alive) return;
            const next = stageIndex + 1;
            if (next < STAGES.length) {
              console.info("[DELI MAN] NEXT LEVEL", {
                from: def.id,
                to: STAGES[next].id,
              });
              setStage(next);
            } else setStage(null);
          });
        }
        update(_: number, dt: number) {
          try {
            this.tick(dt);
          } catch (error) {
            if (this.time.now - this.lastLoopErrorAt > 1000) {
              this.lastLoopErrorAt = this.time.now;
              console.error("[DELI MAN] RECOVERED GAME LOOP ERROR", {
                level: def.id,
                state: this.gameState,
                error,
              });
            }
            if (this.gameState === "BOSS_INTRO")
              this.setGameState("BOSS_FIGHT");
            else if (this.gameState === "BOSS_DEFEATED")
              this.setGameState("REWARD");
          }
        }
        tick(_dt: number) {
          const body = this.player.body as Phaser.Physics.Arcade.Body;
          if (touch.current.mapPressed) {
            touch.current.mapPressed = false;
            this.toggleMap();
          }
          if (this.mapVisible) {
            this.stateStartedAt += _dt;
            return;
          }
          this.enemies.children.iterate((child) => {
            const enemy = child as Phaser.Physics.Arcade.Sprite;
            const enemyBody = enemy.body as Phaser.Physics.Arcade.Body | null;
            if (!enemyBody) return true;
            if (enemyBody.blocked.left)
              enemy.setVelocityX(Number(enemy.getData("patrolSpeed")));
            else if (enemyBody.blocked.right)
              enemy.setVelocityX(-Number(enemy.getData("patrolSpeed")));
            enemy.setFlipX(enemyBody.velocity.x > 0);
            return true;
          });
          this.shots.children.iterate((child) => {
            const shot = child as Phaser.Physics.Arcade.Sprite;
            if (this.time.now - Number(shot.getData("bornAt")) > 1200)
              shot.destroy();
            return true;
          });
          if (body.blocked.down) this.lastGroundedAt = this.time.now;
          const left =
              this.cursors.left.isDown ||
              this.keys.A.isDown ||
              touch.current.left,
            right =
              this.cursors.right.isDown ||
              this.keys.D.isDown ||
              touch.current.right;
          const controlsLocked = this.time.now < this.controlLockedUntil;
          if (left) this.facing = -1;
          if (right) this.facing = 1;
          this.player.setFlipX(this.facing < 0);
          if (!controlsLocked && this.time.now >= this.dashUntil)
            this.player.setVelocityX(left ? -245 : right ? 245 : 0);
          else if (!controlsLocked && this.time.now < this.dashUntil)
            this.player.setVelocityX(this.facing * 465);
          const activeLadder = this.ladders.find(
            (r) =>
              Math.abs(this.player.x - r.x - 24) < 42 &&
              this.player.y > r.top - 24 &&
              this.player.y < r.bottom + 20,
          );
          const ladder = Boolean(activeLadder);
          if (
            !controlsLocked &&
            ladder &&
            (this.cursors.up.isDown || this.keys.W.isDown)
          ) {
            this.player.x = P.Math.Linear(
              this.player.x,
              activeLadder!.x + 24,
              0.28,
            );
            body.setAllowGravity(false);
            this.player.setVelocityY(-190);
          } else if (
            !controlsLocked &&
            ladder &&
            (this.cursors.down.isDown || this.keys.S.isDown)
          ) {
            this.player.x = P.Math.Linear(
              this.player.x,
              activeLadder!.x + 24,
              0.28,
            );
            body.setAllowGravity(false);
            this.player.setVelocityY(190);
          } else body.setAllowGravity(true);
          if (
            !controlsLocked &&
            (P.Input.Keyboard.JustDown(this.cursors.up) ||
              P.Input.Keyboard.JustDown(this.keys.W) ||
              touch.current.jumpPressed)
          ) {
            touch.current.jumpPressed = false;
            this.jump();
          }
          if (
            !touch.current.jump &&
            !this.cursors.up.isDown &&
            !this.keys.W.isDown
          )
            this.cutJump();
          if (touch.current.fire && !this.chargeStartedAt)
            this.chargeStartedAt = this.time.now;
          if (touch.current.fireReleased) {
            touch.current.fireReleased = false;
            this.fire(
              Boolean(
                this.chargeStartedAt &&
                this.time.now - this.chargeStartedAt >= 650,
              ),
            );
            this.chargeStartedAt = 0;
          }
          if (touch.current.dashPressed) {
            touch.current.dashPressed = false;
            this.dash();
          }
          if (
            !controlsLocked &&
            this.jumpQueuedAt &&
            this.time.now - this.jumpQueuedAt < 120 &&
            this.time.now - this.lastGroundedAt < 125
          ) {
            this.jumpQueuedAt = 0;
            this.jump();
          }
          const wallSliding =
            !controlsLocked &&
            !body.blocked.down &&
            body.velocity.y > 0 &&
            (body.blocked.left || body.blocked.right);
          if (wallSliding)
            this.player.setVelocityY(Math.min(body.velocity.y, 105));
          if (
            wallSliding &&
            (P.Input.Keyboard.JustDown(this.cursors.up) ||
              P.Input.Keyboard.JustDown(this.keys.W) ||
              touch.current.jumpPressed)
          ) {
            this.player.setVelocity(body.blocked.left ? 330 : -330, -470);
          }
          const pad = this.input.gamepad?.getPad(0);
          if (pad && !controlsLocked) {
            this.player.setVelocityX(pad.leftStick.x * 260);
            if (pad.A) this.jump();
            if (pad.X) this.fire();
            if (pad.B) this.dash();
          }
          this.distance = Math.max(this.distance, this.player.x);
          const desiredCameraX = P.Math.Clamp(
            this.player.x - this.scale.width * 0.38,
            0,
            5000 - this.scale.width,
          );
          this.cameraFurthestX = Math.max(this.cameraFurthestX, desiredCameraX);
          this.cameras.main.scrollX = this.cameraFurthestX;
          if (this.player.x < this.cameraFurthestX + 20)
            this.player.x = this.cameraFurthestX + 20;
          if (controlsLocked) this.playerState = "hurt";
          else if (this.time.now < this.dashUntil) this.playerState = "dashing";
          else if (ladder && !body.allowGravity) this.playerState = "climbing";
          else if (wallSliding) this.playerState = "wall_slide";
          else if (!body.blocked.down) this.playerState = "airborne";
          else if (body.velocity.x !== 0) this.playerState = "run";
          else this.playerState = "grounded";
          const firedRecently = this.time.now - this.lastShotAt < 150;
          const heroTexture =
            this.playerState === "hurt"
              ? "hero-hurt"
              : firedRecently
                ? "hero-shoot"
                : this.playerState === "airborne" ||
                    this.playerState === "wall_slide"
                  ? "hero-jump"
                  : this.playerState === "run"
                    ? Math.floor(this.time.now / 105) % 2
                      ? "hero-run-a"
                      : "hero-run-b"
                    : "hero-idle";
          if (this.player.texture.key !== heroTexture)
            this.player.setTexture(heroTexture);
          this.checkpoint = Math.max(
            this.checkpoint,
            Math.floor(this.player.x / 1000),
          );
          const roomIndex = Math.min(4, Math.floor(this.player.x / 1000));
          const room = buildStageRooms(def.id).filter(
            (candidate) => candidate.kind !== "secret",
          )[roomIndex];
          if (room) {
            this.visitedRooms.add(room.id);
            this.mapOverlay.list.forEach((item) => {
              const gameObject = item as Phaser.GameObjects.GameObject & {
                getData?: (key: string) => unknown;
                setFillStyle?: (color: number) => unknown;
                setColor?: (color: string) => unknown;
              };
              if (gameObject.getData?.("roomId") === room.id)
                gameObject.setFillStyle?.(0x257143);
              if (gameObject.getData?.("roomLabel") === room.id)
                gameObject.setColor?.("#d8ffe0");
            });
          }
          if (this.player.x > this.respawnX + 950)
            this.respawnX = Math.floor(this.player.x / 1000) * 1000 + 80;
          if (this.player.x > 4550 || this.bossActive) {
            if (!this.bossActive) {
              this.bossActive = true;
              this.setGameState("BOSS_INTRO");
              this.bossWarning
                .setText(`!! WARNING !!\n${bossProfile?.name ?? def.boss}`)
                .setScale(0.72)
                .setAlpha(0)
                .setVisible(true);
              this.tweens.add({
                targets: this.bossWarning,
                alpha: 1,
                scale: 1,
                duration: 180,
                yoyo: true,
                hold: 420,
              });
              console.info("[DELI MAN] BOSS TRIGGER", { level: def.id });
              this.enemies.clear(true, true);
              this.shots.clear(true, true);
              this.bossSprite.setVisible(true);
              this.entranceGate.setVisible(true);
              (
                this.entranceGate.body as Phaser.Physics.Arcade.StaticBody
              ).enable = true;
              this.cameras.main.flash(250, 255, 70, 30);
            }
            if (
              this.gameState === "BOSS_INTRO" &&
              this.time.now - this.stateStartedAt > 850
            ) {
              this.bossSprite.enableBody(false, 4680, 530, true, true);
              this.bossWarning.setVisible(false);
              this.setGameState("BOSS_FIGHT");
              console.info("[DELI MAN] BOSS SPAWN", { level: def.id });
            }
            if (this.gameState === "BOSS_FIGHT") {
              this.physics.moveToObject(
                this.bossSprite,
                this.player,
                bossProfile?.speed ?? 45 + stageIndex * 6,
              );
              if (
                P.Math.Distance.BetweenPoints(this.player, this.bossSprite) < 88
              )
                this.damage();
            }
            if (
              this.gameState === "BOSS_DEFEATED" &&
              this.time.now - this.stateStartedAt > 650
            ) {
              this.setGameState("REWARD");
              this.cameras.main.shake(380, 0.012);
              this.cameras.main.flash(180, 255, 210, 55);
              this.exitDoor.setVisible(true);
              console.info("[DELI MAN] BOSS DEFEATED", { level: def.id });
            }
            if (this.gameState === "REWARD" && this.player.x > 4870)
              this.completeLevel();
            if (
              (this.gameState === "BOSS_INTRO" ||
                this.gameState === "BOSS_DEFEATED") &&
              this.time.now - this.stateStartedAt > 5000
            )
              this.setGameState(
                this.gameState === "BOSS_INTRO" ? "BOSS_FIGHT" : "REWARD",
              );
          }
          this.tip.setText(
            `PATIENCE ${"■".repeat(this.hp)}  TIP CHANGE $${this.score}  ${this.playerState.toUpperCase()}\n${def.name} · CHECKPOINT ${this.checkpoint + 1}${this.bossActive ? `\n${bossProfile?.name ?? def.boss}: ${"★".repeat(Math.max(0, this.boss))}${this.bossDefeated ? "  DELIVER TO GREEN DOOR" : ""}` : ""}`,
          );
          if (this.debugVisible)
            this.debugText.setText(
              `FPS ${Math.round(this.game.loop.actualFps)} | LEVEL ${stageIndex + 1}/9 | ${this.gameState}\nPLAYER ${Math.round(this.player.x)},${Math.round(this.player.y)} | CAMERA ${Math.round(this.cameras.main.scrollX)},${Math.round(this.cameras.main.scrollY)}\nENEMIES ${this.enemies.countActive(true)} | BOSS ${this.bossActive ? this.boss : "OFF"} | PIZZAS ${this.shots.countActive(true)}\nTRANSITION ${this.gameState.includes("INTRO") || this.gameState === "BOSS_DEFEATED" ? 1 : 0} | EFFECTS ${this.tweens.getTweens().length}\nDEV: B=BOSS  K=ONE-HIT  H=DEATH  ` +
                "`=DEBUG",
            );
        }
      }
      instance = new P.Game({
        type: P.AUTO,
        parent: host.current,
        width: 1280,
        height: 720,
        backgroundColor: def.theme,
        render: { pixelArt: true, antialias: false, roundPixels: true },
        physics: {
          default: "arcade",
          arcade: { gravity: { x: 0, y: 1750 }, debug: false },
        },
        scale: { mode: P.Scale.FIT, autoCenter: P.Scale.CENTER_BOTH },
        scene: Scene,
        audio: { noAudio: !sound },
        input: { gamepad: true },
      });
      game.current = instance;
    });
    return () => {
      alive = false;
      instance?.destroy(true);
      if (game.current === instance) game.current = null;
      touch.current = {
        left: false,
        right: false,
        jump: false,
        jumpPressed: false,
        fire: false,
        fireHeld: false,
        fireReleased: false,
        dashPressed: false,
        mapPressed: false,
      };
    };
  }, [sound, stage]);
  return (
    <main className="deli-man">
      {stage === null ? (
        <section>
          <small>AN ORIGINAL CORNER DELI GAME</small>
          <h1 className="title-logo">
            <span>DELI MAN</span>
            <i>THE LAST JUMBO</i>
          </h1>
          <div className="world-map" aria-label="Deli Man stage map">
            <div className="map-route map-route-a" />
            <div className="map-route map-route-b" />
            {STAGES.map((s, i) => (
              <button
                key={s.id}
                className={`${progress?.completedStages.includes(s.id) ? "complete" : ""} map-node map-node-${i + 1}`}
                onClick={() => setStage(i)}
                style={{
                  backgroundImage: `url(${getDeliManArt(s.id).background})`,
                }}
              >
                <span className="stage-copy">
                  <b>
                    {i + 1}. {s.name}
                  </b>
                  <span>BOSS: {s.boss}</span>
                  <em>GET: {s.ability}</em>
                  <small>
                    {progress?.completedStages.includes(s.id)
                      ? `CLEARED · BEST ${progress.bestScores[s.id] || 0}`
                      : `${buildStageRooms(s.id).length} ROOMS · SECRET UNKNOWN`}
                  </small>
                </span>
              </button>
            ))}
          </div>
          <footer>
            <button onClick={() => setSound(!sound)}>
              {sound ? "SOUND: ON" : "SOUND: OFF"}
            </button>
            <a href="/games">ALL GAMES</a>
          </footer>
        </section>
      ) : (
        <>
          <div className="game-shell">
            <div ref={host} className="game-container" />
          </div>
          <nav className="mobile-controls" aria-label="Game controls">
            <div className="d-pad">
              <button
                className="control-btn"
                aria-label="Move left"
                onContextMenu={(event) => event.preventDefault()}
                onPointerDown={(event) => {
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // Some embedded/mobile browsers do not expose pointer capture.
                  }
                  touch.current.left = true;
                }}
                onPointerUp={() => (touch.current.left = false)}
                onPointerCancel={() => (touch.current.left = false)}
                onPointerLeave={() => (touch.current.left = false)}
              >
                ◀
              </button>
              <button
                className="control-btn"
                aria-label="Move right"
                onContextMenu={(event) => event.preventDefault()}
                onPointerDown={(event) => {
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // Movement still works through pointer up/cancel handlers.
                  }
                  touch.current.right = true;
                }}
                onPointerUp={() => (touch.current.right = false)}
                onPointerCancel={() => (touch.current.right = false)}
                onPointerLeave={() => (touch.current.right = false)}
              >
                ▶
              </button>
            </div>
            <div className="action-buttons">
              <button
                className="control-btn pizza-control"
                aria-label="Fire pizza blaster; hold to charge"
                onPointerDown={(event) => {
                  event.preventDefault();
                  touch.current.fire = true;
                  touch.current.fireHeld = true;
                }}
                onPointerUp={() => {
                  touch.current.fire = false;
                  touch.current.fireHeld = false;
                  touch.current.fireReleased = true;
                }}
                onPointerCancel={() => {
                  touch.current.fire = false;
                  touch.current.fireHeld = false;
                  touch.current.fireReleased = true;
                }}
              >
                FIRE
              </button>
              <button
                className="control-btn"
                aria-label="Jump"
                onPointerDown={(event) => {
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // Jump remains responsive without pointer capture.
                  }
                  touch.current.jump = true;
                  touch.current.jumpPressed = true;
                }}
                onPointerUp={() => (touch.current.jump = false)}
                onPointerCancel={() => (touch.current.jump = false)}
                onPointerLeave={() => (touch.current.jump = false)}
              >
                ▲
              </button>
              <button
                className="control-btn dash-control"
                aria-label="Dash"
                onPointerDown={(event) => {
                  event.preventDefault();
                  touch.current.dashPressed = true;
                }}
              >
                DASH
              </button>
              <button
                className="pause-control"
                onClick={() => {
                  touch.current.mapPressed = true;
                }}
              >
                MAP
              </button>
            </div>
          </nav>
        </>
      )}
    </main>
  );
}
