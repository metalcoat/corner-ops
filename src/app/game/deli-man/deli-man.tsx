"use client";
import { useEffect, useRef, useState } from "react";
import type Phaser from "phaser";
import { STAGES } from "@/lib/games/deli-man-data";
export default function DeliMan() {
  const host = useRef<HTMLDivElement>(null),
    game = useRef<Phaser.Game | null>(null);
  const [stage, setStage] = useState<number | null>(null),
    [sound, setSound] = useState(true);
  useEffect(() => {
    if (stage === null || !host.current) return;
    const stageIndex = stage;
    let alive = true;
    void import("phaser").then((P) => {
      if (!alive || !host.current) return;
      const def = STAGES[stageIndex];
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
        boss = 12 + stageIndex * 3;
        checkpoint = 0;
        invuln = 0;
        facing = 1;
        bossActive = false;
        bossDefeated = false;
        lastGroundedAt = 0;
        jumpQueuedAt = 0;
        lastShotAt = 0;
        respawnX = 100;
        bossSprite!: Phaser.Physics.Arcade.Sprite;
        exitDoor!: Phaser.GameObjects.Rectangle;
        ladders: Array<{ x: number; top: number; bottom: number }> = [];
        preload() {
          this.load.image(
            "ogdensburg",
            "/games/deli-man/ogdensburg-waterfront-v2.png",
          );
        }
        create() {
          this.cameras.main.setBackgroundColor(def.theme);
          for (let x = 0; x < 6000; x += 2040)
            this.add
              .image(x, 0, "ogdensburg")
              .setOrigin(0)
              .setDisplaySize(2048, 680)
              .setScrollFactor(0.18)
              .setAlpha(stageIndex === 3 ? 0.5 : 0.82);
          const g = this.add.graphics();
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
          g.fillStyle(0x192129).fillRect(0, 610, 5000, 110);
          g.fillStyle(0xffffff, 0.25);
          for (let x = 0; x < 5000; x += 260) g.fillRect(x, 675, 120, 7);
          g.generateTexture("ground", 8, 8);
          this.physics.world.setBounds(0, 0, 5000, 720);
          const ground = this.physics.add.staticGroup();
          ground.create(2500, 650).setDisplaySize(5000, 80).refreshBody();
          const platforms = this.physics.add.staticGroup();
          const authoredRoutes = [
            { x: 720, top: 420, width: 300 },
            { x: 1740, top: 350, width: 360 },
            { x: 2860, top: 430, width: 330 },
            { x: 4020, top: 330, width: 390 },
          ];
          authoredRoutes.forEach((route) => {
            this.ladders.push({ x: route.x, top: route.top, bottom: 610 });
            platforms
              .create(route.x + route.width / 2 - 18, route.top, "ground")
              .setDisplaySize(route.width, 24)
              .refreshBody();
            g.lineStyle(8, 0xd3b56f);
            g.lineBetween(route.x, 610, route.x, route.top);
            g.lineBetween(route.x + 48, 610, route.x + 48, route.top);
            for (let y = route.top + 12; y < 610; y += 27)
              g.lineBetween(route.x, y, route.x + 48, y);
          });
          const make = (key: string, color: number, w: number, h: number) => {
            const q = this.make.graphics({ x: 0, y: 0 }, false);
            q.fillStyle(color).fillRect(0, 0, w, h);
            q.lineStyle(3, 0xffffff).strokeRect(0, 0, w, h);
            q.generateTexture(key, w, h);
            q.destroy();
          };
          make("hero", 0xf04435, 38, 58);
          const enemyArt = this.make.graphics({ x: 0, y: 0 }, false);
          enemyArt.fillStyle(0x43842f).fillCircle(25, 25, 23);
          enemyArt
            .fillStyle(0xffe73f)
            .fillCircle(16, 19, 5)
            .fillCircle(34, 19, 5);
          enemyArt
            .fillStyle(0x111111)
            .fillCircle(17, 20, 2)
            .fillCircle(33, 20, 2);
          enemyArt.fillStyle(0x8c1b17).fillRect(12, 32, 26, 7);
          enemyArt
            .fillStyle(0x26351e)
            .fillRect(2, 42, 14, 8)
            .fillRect(34, 42, 14, 8);
          enemyArt.generateTexture("enemy", 50, 50);
          enemyArt.destroy();
          const enemyWalk = this.make.graphics({ x: 0, y: 0 }, false);
          enemyWalk.fillStyle(0x58a13d).fillCircle(25, 24, 23);
          enemyWalk
            .fillStyle(0xffe73f)
            .fillCircle(16, 18, 5)
            .fillCircle(34, 18, 5);
          enemyWalk
            .fillStyle(0x111111)
            .fillCircle(17, 19, 2)
            .fillCircle(33, 19, 2);
          enemyWalk.fillStyle(0x8c1b17).fillRect(12, 31, 26, 7);
          enemyWalk
            .fillStyle(0x26351e)
            .fillRect(8, 42, 14, 8)
            .fillRect(29, 39, 14, 8);
          enemyWalk.generateTexture("enemy-walk", 50, 50);
          enemyWalk.destroy();
          const bossArt = this.make.graphics({ x: 0, y: 0 }, false);
          bossArt.fillStyle(0x5d1820).fillCircle(62, 63, 58);
          bossArt.fillStyle(0xffca39).fillRect(17, 18, 90, 25);
          bossArt
            .fillStyle(0xffffff)
            .fillCircle(42, 56, 10)
            .fillCircle(82, 56, 10);
          bossArt
            .fillStyle(0x111111)
            .fillCircle(44, 58, 4)
            .fillCircle(84, 58, 4);
          bossArt.fillStyle(0xf04435).fillRect(30, 82, 64, 14);
          bossArt.generateTexture("boss", 124, 124);
          bossArt.destroy();
          const makePerson = (key: string, shirt: number, hat = false) => {
            const p = this.make.graphics({ x: 0, y: 0 }, false);
            if (hat) p.fillStyle(0xf0ad20).fillRect(9, 0, 28, 8);
            p.fillStyle(0xb87548).fillCircle(23, 15, 12);
            p.fillStyle(shirt).fillRect(8, 27, 30, 31);
            p.fillStyle(0x172432)
              .fillRect(8, 56, 12, 24)
              .fillRect(27, 56, 12, 24);
            p.fillStyle(0x1b1110)
              .fillRect(5, 76, 17, 7)
              .fillRect(25, 76, 17, 7);
            p.generateTexture(key, 46, 84);
            p.destroy();
          };
          makePerson("roofer", 0xf08324, true);
          makePerson("customer", 0x7d45a8);
          makePerson("pedestrian", 0x3a78a8);
          make("shot", 0xffd638, 22, 10);
          this.player = this.physics.add
            .sprite(100, 560, "hero")
            .setCollideWorldBounds(true);
          this.player.body!.setSize(34, 56);
          const heroArt = this.add.graphics();
          heroArt.fillStyle(0xd92f27).fillRect(2, 0, 34, 12);
          heroArt.fillStyle(0xf1b783).fillRect(8, 12, 24, 14);
          heroArt.fillStyle(0x162f50).fillRect(4, 26, 30, 20);
          heroArt.fillStyle(0xead4a0).fillRect(9, 29, 20, 25);
          heroArt
            .fillStyle(0x111820)
            .fillRect(3, 48, 13, 10)
            .fillRect(23, 48, 13, 10);
          heroArt.generateTexture("deli-man", 38, 58);
          heroArt.destroy();
          this.player.setTexture("deli-man");
          this.cameras.main.startFollow(this.player, true, 0.09, 0.09);
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
            this.add.text(x - 26, 515, String(e.getData("name")), {
              fontFamily: "monospace",
              fontSize: "10px",
              color: "#ffef73",
              backgroundColor: "#111c",
            });
            e.setVelocityX(-30 - stageIndex * 8);
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
          this.bossSprite.body!.enable = false;
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
          [640, 1450, 2260, 3180, 4140].forEach((x) => {
            const coin = this.add
              .circle(x, 500, 11, 0xffd438)
              .setStrokeStyle(3, 0xffffff);
            pickups.add(coin);
            this.tweens.add({
              targets: coin,
              y: 486,
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
            a.destroy();
            b.destroy();
            this.score += 100;
          });
          this.physics.add.overlap(this.shots, this.bossSprite, (a) => {
            a.destroy();
            if (!this.bossActive || this.bossDefeated) return;
            this.boss--;
            this.bossSprite.setTint(0xffffff);
            this.time.delayedCall(70, () => this.bossSprite.clearTint());
            if (this.boss <= 0) {
              this.bossDefeated = true;
              this.bossSprite.disableBody(true, true);
              this.exitDoor.setVisible(true);
              this.score += 2500;
            }
          });
          this.physics.add.collider(this.player, ground);
          this.physics.add.collider(this.bossSprite, ground);
          this.physics.add.collider(this.player, platforms);
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
          this.add
            .text(100, 120, def.intro, {
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
          this.input.keyboard!.on("keydown-X", () => this.fire());
          this.input.keyboard!.on("keydown-F", () => this.fire());
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
          this.input.gamepad?.once("connected", () => {});
          this.input.on("pointerdown", (p: Phaser.Input.Pointer) =>
            p.x > this.scale.width * 0.55 ? this.fire() : this.jump(),
          );
        }
        jump() {
          if (this.time.now - this.lastGroundedAt < 125)
            this.player.setVelocityY(-520);
        }
        cutJump() {
          const body = this.player.body as Phaser.Physics.Arcade.Body;
          if (body.velocity.y < -180) this.player.setVelocityY(-180);
        }
        fire() {
          if (this.time.now - this.lastShotAt < 175) return;
          this.lastShotAt = this.time.now;
          const b = this.shots.create(
            this.player.x + this.facing * 32,
            this.player.y,
            "shot",
          ) as Phaser.Physics.Arcade.Sprite;
          b.setVelocityX(this.facing * 620);
        }
        damage() {
          if (this.time.now < this.invuln) return;
          this.invuln = this.time.now + 900;
          this.hp--;
          this.player.setTint(0xffffff).setVelocity(-180, -260);
          this.time.delayedCall(200, () => this.player.clearTint());
          if (this.hp <= 0) {
            this.hp = 8;
            this.player.setPosition(this.respawnX, 540).setVelocity(0, 0);
          }
        }
        update(_: number, dt: number) {
          const body = this.player.body as Phaser.Physics.Arcade.Body;
          if (body.blocked.down) this.lastGroundedAt = this.time.now;
          const left = this.cursors.left.isDown || this.keys.A.isDown,
            right = this.cursors.right.isDown || this.keys.D.isDown;
          if (left) this.facing = -1;
          if (right) this.facing = 1;
          this.player.setFlipX(this.facing < 0);
          this.player.setVelocityX(left ? -230 : right ? 230 : 0);
          const ladder = this.ladders.some(
            (r) =>
              Math.abs(this.player.x - r.x - 24) < 42 &&
              this.player.y > r.top - 24 &&
              this.player.y < r.bottom + 20,
          );
          if (ladder && (this.cursors.up.isDown || this.keys.W.isDown)) {
            body.setAllowGravity(false);
            this.player.setVelocityY(-190);
          } else if (
            ladder &&
            (this.cursors.down.isDown || this.keys.S.isDown)
          ) {
            body.setAllowGravity(false);
            this.player.setVelocityY(190);
          } else body.setAllowGravity(true);
          if (
            P.Input.Keyboard.JustDown(this.cursors.up) ||
            P.Input.Keyboard.JustDown(this.keys.W)
          )
            this.jump();
          if (
            this.jumpQueuedAt &&
            this.time.now - this.jumpQueuedAt < 120 &&
            this.time.now - this.lastGroundedAt < 125
          ) {
            this.jumpQueuedAt = 0;
            this.jump();
          }
          if (
            !body.blocked.down &&
            body.velocity.y > 0 &&
            (body.blocked.left || body.blocked.right) &&
            (this.cursors.up.isDown || this.keys.W.isDown)
          ) {
            this.player.setVelocity(body.blocked.left ? 330 : -330, -470);
          }
          if (
            (this.cursors.down.isDown || this.keys.SHIFT.isDown) &&
            body.blocked.down
          )
            this.player.setVelocityX((left ? -1 : 1) * 390);
          const pad = this.input.gamepad?.getPad(0);
          if (pad) {
            this.player.setVelocityX(pad.leftStick.x * 260);
            if (pad.A) this.jump();
            if (pad.X) this.fire();
          }
          this.distance = Math.max(this.distance, this.player.x);
          this.checkpoint = Math.max(
            this.checkpoint,
            Math.floor(this.player.x / 1000),
          );
          if (this.player.x > this.respawnX + 950)
            this.respawnX = Math.floor(this.player.x / 1000) * 1000 + 80;
          if (this.player.x > 4550) {
            if (!this.bossActive) {
              this.bossActive = true;
              this.bossSprite.setVisible(true);
              this.bossSprite.body!.enable = true;
              this.cameras.main.flash(250, 255, 70, 30);
            }
            if (!this.bossDefeated) {
              this.physics.moveToObject(
                this.bossSprite,
                this.player,
                45 + stageIndex * 6,
              );
              if (
                P.Math.Distance.BetweenPoints(this.player, this.bossSprite) < 88
              )
                this.damage();
            }
            if (this.bossDefeated && this.player.x > 4870) {
              const save = JSON.parse(
                localStorage.getItem("deli-man-save") || "{}",
              );
              save[def.id] = true;
              save[def.ability] = true;
              localStorage.setItem("deli-man-save", JSON.stringify(save));
              this.game.destroy(true);
              setStage(null);
            }
          }
          this.tip.setText(
            `PATIENCE ${"■".repeat(this.hp)}  TIP CHANGE $${this.score}\n${def.name} · CHECKPOINT ${this.checkpoint + 1}${this.bossActive ? `\n${def.boss}: ${"★".repeat(Math.max(0, this.boss))}${this.bossDefeated ? "  DELIVER TO GREEN DOOR" : ""}` : ""}`,
          );
        }
      }
      game.current = new P.Game({
        type: P.AUTO,
        parent: host.current,
        width: 1280,
        height: 720,
        backgroundColor: def.theme,
        physics: {
          default: "arcade",
          arcade: { gravity: { x: 0, y: 1200 }, debug: false },
        },
        scale: { mode: P.Scale.FIT, autoCenter: P.Scale.CENTER_BOTH },
        scene: Scene,
        audio: { noAudio: !sound },
        input: { gamepad: true },
      });
    });
    return () => {
      alive = false;
      game.current?.destroy(true);
      game.current = null;
    };
  }, [sound, stage]);
  return (
    <main className="deli-man">
      {stage === null ? (
        <section>
          <small>AN ORIGINAL CORNER DELI GAME</small>
          <h1>
            DELI MAN:<i>THE LAST JUMBO</i>
          </h1>
          <div className="stage-grid">
            {STAGES.map((s, i) => (
              <button key={s.id} onClick={() => setStage(i)}>
                <b>
                  {i + 1}. {s.name}
                </b>
                <span>BOSS: {s.boss}</span>
                <em>GET: {s.ability}</em>
              </button>
            ))}
            <button className="locked">
              <b>THE OWNER&apos;S OFFICE</b>
              <span>DEFEAT ALL EIGHT</span>
            </button>
          </div>
          <footer>
            <button onClick={() => setSound(!sound)}>
              {sound ? "🔊 SOUND ON" : "🔇 SOUND OFF"}
            </button>
            <a href="/games">ALL GAMES</a>
          </footer>
        </section>
      ) : (
        <>
          <div ref={host} />
          <nav>
            <button onPointerDown={() => {}}>◀ MOVE</button>
            <button>JUMP</button>
            <button>SAUCE BLASTER</button>
            <button onClick={() => setStage(null)}>PAUSE / STAGES</button>
          </nav>
        </>
      )}
    </main>
  );
}
