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
        ladders = [820, 1760, 2920, 3890];
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
          for (let x = 350; x < 4900; x += 620) {
            g.fillStyle(x % 1240 ? 0x6f5545 : 0x8a6a50).fillRect(
              x,
              385,
              310,
              225,
            );
            g.fillStyle(0x352b29).fillTriangle(
              x - 25,
              385,
              x + 155,
              270,
              x + 335,
              385,
            );
            g.fillStyle(0x181717)
              .fillRect(x + 45, 455, 65, 80)
              .fillRect(x + 195, 455, 65, 80);
            if (x % 1240 === 350) {
              g.fillStyle(0xd6c5a0).fillRect(x + 138, 195, 34, 190);
              g.fillTriangle(x + 120, 195, x + 155, 125, x + 190, 195);
              this.add.text(x + 70, 350, "ROOF CREW:\nBACK NEXT SPRING", {
                fontFamily: "monospace",
                fontSize: "13px",
                color: "#ffdf54",
                backgroundColor: "#111d",
              });
            } else
              this.add.text(
                x + 70,
                520,
                x % 1860 ? "+59% TAX\nINCREASE" : "GREG STILL\nHAS THE KEYS",
                {
                  fontFamily: "monospace",
                  fontSize: "14px",
                  color: "#ffec60",
                  backgroundColor: "#651b16dd",
                },
              );
          }
          g.fillStyle(0x192129).fillRect(0, 610, 5000, 110);
          g.fillStyle(0xffffff, 0.25);
          for (let x = 0; x < 5000; x += 260) g.fillRect(x, 675, 120, 7);
          g.generateTexture("ground", 8, 8);
          this.physics.world.setBounds(0, 0, 5000, 720);
          const ground = this.physics.add.staticGroup();
          ground.create(2500, 650).setDisplaySize(5000, 80).refreshBody();
          const platforms = this.physics.add.staticGroup();
          this.ladders.forEach((x, index) => {
            platforms
              .create(x + 110, 390, "ground")
              .setDisplaySize(310, 24)
              .refreshBody();
            g.lineStyle(8, 0xd3b56f);
            g.lineBetween(x, 610, x, 400);
            g.lineBetween(x + 48, 610, x + 48, 400);
            for (let y = 420; y < 610; y += 27) g.lineBetween(x, y, x + 48, y);
            g.fillStyle(0x5b2d18).fillRect(x + 65, 280, 95, 110);
            g.fillStyle(0xffd447).fillCircle(x + 140, 335, 6);
            this.add.text(x + 69, 250, `CUSTOMER ${index + 1}`, {
              fontFamily: "monospace",
              fontSize: "13px",
              color: "#fff",
              backgroundColor: "#111d",
            });
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
          }
          this.physics.add.collider(this.player, this.enemies, () =>
            this.damage(),
          );
          this.physics.add.overlap(this.shots, this.enemies, (a, b) => {
            a.destroy();
            b.destroy();
            this.score += 100;
          });
          this.physics.add.collider(this.player, ground);
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
          this.input.gamepad?.once("connected", () => {});
          this.input.on("pointerdown", (p: Phaser.Input.Pointer) =>
            p.x > this.scale.width * 0.55 ? this.fire() : this.jump(),
          );
        }
        jump() {
          if ((this.player.body as Phaser.Physics.Arcade.Body).blocked.down)
            this.player.setVelocityY(-520);
        }
        fire() {
          const b = this.shots.create(
            this.player.x + 32,
            this.player.y,
            "shot",
          ) as Phaser.Physics.Arcade.Sprite;
          b.setVelocityX(620);
        }
        damage() {
          if (this.time.now < this.invuln) return;
          this.invuln = this.time.now + 900;
          this.hp--;
          this.player.setTint(0xffffff).setVelocity(-180, -260);
          this.time.delayedCall(200, () => this.player.clearTint());
          if (this.hp <= 0) this.scene.restart();
        }
        update(_: number, dt: number) {
          const body = this.player.body as Phaser.Physics.Arcade.Body;
          const left = this.cursors.left.isDown || this.keys.A.isDown,
            right = this.cursors.right.isDown || this.keys.D.isDown;
          this.player.setVelocityX(left ? -230 : right ? 230 : 0);
          const ladder = this.ladders.some(
            (x) => Math.abs(this.player.x - x - 24) < 42 && this.player.y > 370,
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
          if (this.player.x > 4550) {
            this.player.setVelocityX(0);
            this.tip.setText(
              `BOSS: ${def.boss}\n${"★".repeat(Math.max(0, this.boss))}`,
            );
            if (
              P.Input.Keyboard.JustDown(this.keys.X) ||
              this.input.activePointer.isDown
            )
              this.boss--;
            if (this.boss <= 0) {
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
            `PATIENCE ${"■".repeat(this.hp)}  TIP CHANGE $${this.score}\n${def.name} · CHECKPOINT ${this.checkpoint + 1}`,
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
