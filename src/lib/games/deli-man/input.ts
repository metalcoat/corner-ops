export const BUTTONS = [
  "left",
  "right",
  "up",
  "down",
  "jump",
  "shoot",
  "start",
  "prev",
  "next",
] as const;
export type Button = (typeof BUTTONS)[number];

const KEYMAP: Record<string, Button> = {
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
  KeyZ: "jump",
  KeyK: "jump",
  Space: "jump",
  KeyX: "shoot",
  KeyJ: "shoot",
  Enter: "start",
  Escape: "start",
  KeyP: "start",
  KeyQ: "prev",
  KeyE: "next",
  PageUp: "prev",
  PageDown: "next",
  BracketLeft: "prev",
  BracketRight: "next",
};

/**
 * Merges keyboard and touch sources. `pressed` is an edge that is true for
 * exactly one simulation frame; `released` likewise.
 */
export class Input {
  private codes = new Set<string>();
  private touch = new Set<Button>();
  private prev = new Set<Button>();
  private now = new Set<Button>();
  private latched = new Set<Button>();

  keyDown(code: string) {
    const button = KEYMAP[code];
    if (!button) return false;
    if (!this.codes.has(code)) this.latched.add(button);
    this.codes.add(code);
    return true;
  }

  keyUp(code: string) {
    if (!KEYMAP[code]) return false;
    this.codes.delete(code);
    return true;
  }

  setTouch(button: Button, down: boolean) {
    if (down) {
      if (!this.touch.has(button)) this.latched.add(button);
      this.touch.add(button);
    } else this.touch.delete(button);
  }

  clear() {
    this.codes.clear();
    this.touch.clear();
    this.latched.clear();
  }

  /** Call once at the start of every simulation frame. */
  poll() {
    this.prev = this.now;
    this.now = new Set([...this.touch, ...this.latched]);
    for (const code of this.codes) this.now.add(KEYMAP[code]);
    this.latched.clear();
  }

  held(button: Button) {
    return this.now.has(button);
  }

  pressed(button: Button) {
    return this.now.has(button) && !this.prev.has(button);
  }

  released(button: Button) {
    return !this.now.has(button) && this.prev.has(button);
  }
}
