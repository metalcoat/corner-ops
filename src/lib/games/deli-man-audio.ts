type SfxName =
  | "jump"
  | "dash"
  | "shot"
  | "charge"
  | "hurt"
  | "switch"
  | "secret"
  | "warning"
  | "boss-hit"
  | "boss-down";

const STAGE_ROOTS = [45, 50, 43, 48, 52, 55, 41, 46, 38];
const PATTERNS = [
  [0, 7, 10, 12, 10, 7, 3, 7],
  [0, 3, 7, 10, 7, 12, 10, 7],
  [0, 5, 7, 3, 10, 7, 5, 3],
];

function midiToFrequency(note: number) {
  return 440 * 2 ** ((note - 69) / 12);
}

export class DeliManAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private effects: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private nextNoteAt = 0;
  private stage = 0;
  private boss = false;
  private muted = false;

  async start(stage: number, muted: boolean) {
    this.stage = stage;
    this.muted = muted;
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.music = this.context.createGain();
      this.effects = this.context.createGain();
      this.master.gain.value = muted ? 0 : 0.62;
      this.music.gain.value = 0.22;
      this.effects.gain.value = 0.52;
      this.music.connect(this.master);
      this.effects.connect(this.master);
      this.master.connect(this.context.destination);
    }
    await this.context.resume().catch(() => undefined);
    this.master?.gain.setTargetAtTime(
      muted ? 0 : 0.62,
      this.context.currentTime,
      0.02,
    );
    this.nextNoteAt = this.context.currentTime + 0.04;
    if (!this.timer) this.timer = setInterval(() => this.schedule(), 50);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.context && this.master)
      this.master.gain.setTargetAtTime(
        muted ? 0 : 0.62,
        this.context.currentTime,
        0.02,
      );
  }

  setBoss(active: boolean) {
    if (active === this.boss) return;
    this.boss = active;
    this.step = 0;
    if (active) this.sfx("warning");
  }

  sfx(name: SfxName) {
    if (!this.context || !this.effects || this.muted) return;
    const now = this.context.currentTime;
    const specs: Record<SfxName, [number, number, OscillatorType, number]> = {
      jump: [330, 520, "square", 0.09],
      dash: [150, 85, "sawtooth", 0.12],
      shot: [690, 340, "square", 0.07],
      charge: [420, 980, "triangle", 0.18],
      hurt: [150, 58, "sawtooth", 0.2],
      switch: [440, 880, "square", 0.16],
      secret: [523, 1046, "triangle", 0.36],
      warning: [110, 165, "sawtooth", 0.32],
      "boss-hit": [210, 105, "square", 0.08],
      "boss-down": [330, 55, "sawtooth", 0.7],
    };
    const [from, to, type, duration] = specs[name];
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, now);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(30, to),
      now + duration,
    );
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(this.effects);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  private note(
    note: number,
    at: number,
    length: number,
    volume: number,
    type: OscillatorType,
  ) {
    if (!this.context || !this.music) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(midiToFrequency(note), at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    oscillator.connect(gain);
    gain.connect(this.music);
    oscillator.start(at);
    oscillator.stop(at + length + 0.02);
  }

  private schedule() {
    if (!this.context || this.context.state !== "running") return;
    const beat = this.boss ? 0.115 : 0.145;
    while (this.nextNoteAt < this.context.currentTime + 0.16) {
      const root = STAGE_ROOTS[this.stage % STAGE_ROOTS.length];
      const pattern = PATTERNS[this.stage % PATTERNS.length];
      const index = this.step % pattern.length;
      this.note(
        root - 12 + (index % 4 === 0 ? 0 : 7),
        this.nextNoteAt,
        beat * 0.86,
        0.045,
        "triangle",
      );
      if (index % 2 === 0)
        this.note(
          root + pattern[index] + (this.boss ? 12 : 0),
          this.nextNoteAt,
          beat * 1.55,
          0.035,
          "square",
        );
      if (index % 4 === 2)
        this.note(
          root + 12 + pattern[(index + 3) % pattern.length],
          this.nextNoteAt,
          beat * 0.65,
          0.022,
          "sine",
        );
      this.step += 1;
      this.nextNoteAt += beat;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const context = this.context;
    this.context = null;
    this.master = null;
    this.music = null;
    this.effects = null;
    if (context) void context.close().catch(() => undefined);
  }
}
