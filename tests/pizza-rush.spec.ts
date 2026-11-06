import { expect, test } from "@playwright/test";
import { playRushReplay } from "./fixtures/pizza-rush-replay";
import { validateRushReplay } from "../src/lib/games/pizza-rush/replay";
import type { Stats } from "../src/lib/games/pizza-rush/engine";

test("Jumbo Rush records a verifiable prize run after pause and resize", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 400, height: 700 });
  // Drive the real browser event handlers and animation loop with a legal input
  // trace. The engine and its counters remain private and are never modified.
  await page.addInitScript(() => {
    let now = 0, nextId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    Object.defineProperty(performance, "now", { value: () => now });
    window.requestAnimationFrame = (callback) => { const id = nextId++; frames.set(id, callback); return id; };
    window.cancelAnimationFrame = (id) => { frames.delete(id); };
    (window as unknown as { auditRushFrame: (dt: number) => void }).auditRushFrame = (dt) => {
      now += dt * 1000;
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(now);
    };
    localStorage.setItem("jumbo-rush-muted", "1");
  });
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/pizza-gauntlet/run", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    await route.fulfill({ json: body.action === "start"
      ? { runId: "browser-replay", token: "test-token", seed: 3 }
      : body.action === "arcade_complete" ? { code: "JUMBO-TEST-CODE" } : { ok: true } });
  });
  await page.goto("/game/earn-your-jumbo");
  await page.getByRole("button", { name: "CLOCK IN", exact: true }).dispatchEvent("click");
  await expect(page.locator(".jr-mute")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.getByRole("heading", { name: "ON BREAK" })).toBeVisible();
  await page.setViewportSize({ width: 450, height: 750 });
  await expect.poll(() => page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(450);
  await page.setViewportSize({ width: 400, height: 700 });
  await expect.poll(() => page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(400);
  await page.getByRole("button", { name: "BACK TO WORK" }).dispatchEvent("click");
  await expect(page.locator(".jr-mute")).toBeVisible();
  const fixture = playRushReplay(3);
  await page.evaluate((actions) => {
    const canvas = document.querySelector("canvas")!;
    const rect = canvas.getBoundingClientRect();
    const frame = (window as unknown as { auditRushFrame: (dt: number) => void }).auditRushFrame;
    for (const action of actions) {
      if (action[0] === 0) frame(action[1]);
      else if (action[0] !== 1) canvas.dispatchEvent(new PointerEvent(
        action[0] === 2 ? "pointerdown" : action[0] === 3 ? "pointermove" : "pointerup",
        { bubbles: true, pointerId: 1, pointerType: "mouse", clientX: rect.left + (action[1] || 0), clientY: rect.top + (action[2] || 0) },
      ));
    }
  }, fixture.actions);
  await expect(page.getByText("JUMBO-TEST-CODE", { exact: true })).toBeVisible();
  const complete = requests.find((request) => request.action === "arcade_complete")!;
  expect(complete).toBeTruthy();
  const stats: Stats = { elapsed: 110, score: Number(complete.score), delivered: Number(complete.delivered), perfects: Number(complete.perfects), ruined: Number(complete.ruined) };
  expect(validateRushReplay(3, complete.replay, stats)).toEqual(fixture.stats);
  expect(requests.filter((request) => request.action === "arcade_checkpoint")).toHaveLength(11);
  expect(requests.some((request) => request.action === "arcade_loss")).toBe(false);
});
