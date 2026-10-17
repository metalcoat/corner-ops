import test from "node:test";
import assert from "node:assert/strict";
import { ALERT_SOUNDS, renderAlertSound, roomImpulse } from "../src/lib/alert-sounds.js";

test("every alert sound renders clean, audible stereo under 4 seconds", () => {
  for (const { id } of ALERT_SOUNDS) {
    const { left, right } = renderAlertSound(id, 22050);
    assert.equal(left.length, right.length, id);
    assert.ok(left.length / 22050 < 4, `${id} is too long`);
    let peak = 0, energy = 0;
    for (let i = 0; i < left.length; i++) {
      assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]), `${id} has a bad sample`);
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
      energy += left[i] * left[i];
    }
    assert.ok(peak <= 0.9 && peak > 0.5, `${id} peak ${peak}`);
    assert.ok(energy / left.length > 1e-4, `${id} is nearly silent`);
    // Ends silent (no click when it stops).
    assert.ok(Math.abs(left[left.length - 1]) < 1e-3, `${id} ends abruptly`);
  }
});

test("sounds render the same on every device", () => {
  const a = renderAlertSound("register_chime", 22050), b = renderAlertSound("register_chime", 22050);
  assert.deepEqual(a.left.slice(0, 2000), b.left.slice(0, 2000));
});

test("room echo decays", () => {
  const { left } = roomImpulse(22050);
  const early = Math.max(...left.slice(400, 2000).map(Math.abs)), late = Math.max(...left.slice(-2000).map(Math.abs));
  assert.ok(late < early / 20);
});
