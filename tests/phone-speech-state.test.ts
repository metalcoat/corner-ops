import test from "node:test";
import assert from "node:assert/strict";
import {
  PhoneSpeechState,
  needsSpeechRecovery,
} from "../src/lib/phone-speech-state.js";

test("generated text waits for outbound audio to drain before tail recovery", () => {
  const state = new PhoneSpeechState();
  let retries = 0;
  state.start();
  state.audio();
  state.done();
  assert.equal(state.busy, true);
  state.recover(() => retries++);
  assert.equal(retries, 0);
  state.drained();
  assert.equal(state.busy, false);
  assert.equal(retries, 1);
  state.drained();
  assert.equal(retries, 1);
});
test("playback draining before generation also waits", () => {
  const state = new PhoneSpeechState();
  let retries = 0;
  state.start();
  state.audio();
  state.recover(() => retries++);
  state.drained();
  assert.equal(retries, 0);
  state.done();
  assert.equal(retries, 1);
});
test("overlapping caller audio invalidates queued recovery and never replays cancelled speech", () => {
  const state = new PhoneSpeechState();
  let retries = 0;
  state.start();
  state.audio();
  state.done();
  state.recover(() => retries++);
  state.interrupt();
  state.drained();
  assert.equal(retries, 0);
  assert.equal(needsSpeechRecovery("cancelled", true, false), false);
  assert.equal(needsSpeechRecovery("incomplete", false, true), false);
  state.start();
  assert.equal(state.interrupted, false);
});
test("incomplete generation recovers even with a grammatically finished transcript", () => {
  assert.equal(needsSpeechRecovery("incomplete", false, false), true);
  assert.equal(needsSpeechRecovery("completed", false, false), false);
});
