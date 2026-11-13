/*
 * Tiny 2A03-flavoured chiptune engine: two pulse channels (with duty cycle),
 * a triangle bass and a noise drum channel, plus one-shot sound effects.
 * All melodies are original.
 */

export type SfxName =
  | "shoot"
  | "charge"
  | "chargeHum"
  | "bigShot"
  | "midShot"
  | "hit"
  | "enemyDie"
  | "tink"
  | "hurt"
  | "land"
  | "death"
  | "pickup"
  | "tick"
  | "oneUp"
  | "door"
  | "bossHit"
  | "select"
  | "move"
  | "pause"
  | "ready"
  | "weapon"
  | "thud"
  | "honk"
  | "explode";

type Song = {
  bpm: number;
  lead: string[];
  chords: string[];
  chordSteps: number;
  drums: string;
  loop: boolean;
  duty: number;
  echo?: boolean;
};

const NOTE_INDEX: Record<string, number> = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };

function midi(token: string) {
  const match = /^([A-G]#?)(\d)$/.exec(token);
  if (!match) return null;
  return 12 * (Number(match[2]) + 1) + NOTE_INDEX[match[1]];
}

function freq(note: number) {
  return 440 * 2 ** ((note - 69) / 12);
}

const S = (...bars: string[]) => bars.join(" ").split(/\s+/).filter(Boolean);

export const SONGS: Record<string, Song> = {
  stage0: {
    bpm: 150,
    duty: 0.25,
    chords: ["A2", "F2", "G2", "E2", "A2", "F2", "G2", "E2"],
    chordSteps: 16,
    drums: "k.h.s.h.k.k.s.hh",
    loop: true,
    echo: true,
    lead: S(
      "E5 . . . A5 . . . G5 . E5 . D5 . C5 .",
      "C5 . . . F5 . . . E5 . C5 . A4 . C5 .",
      "D5 . . . G5 . . . F5 . D5 . B4 . D5 .",
      "E5 . . . G#5 . . . B5 . . . G#5 . E5 .",
      "A5 . . . . . G5 . A5 . . . E5 . . .",
      "F5 . . . . . E5 . F5 . . . C5 . . .",
      "G5 . . . . . F5 . G5 . . . D5 . E5 .",
      "E5 . . . . . . . - . E5 . G#5 . B5 .",
    ),
  },
  stage1: {
    bpm: 140,
    duty: 0.125,
    chords: ["D3", "A#2", "C3", "A2", "D3", "A#2", "C3", "A2"],
    chordSteps: 16,
    drums: "k...s..kk.k.s...",
    loop: true,
    echo: true,
    lead: S(
      "D5 . F5 . A5 . . . G5 . F5 . E5 . F5 .",
      "D5 . F5 . A#5 . . . A5 . G5 . F5 . D5 .",
      "E5 . G5 . C6 . . . A#5 . A5 . G5 . E5 .",
      "C#5 . E5 . A5 . . . G5 . E5 . C#5 . A4 .",
      "A5 . . . . . F5 . . . D5 . . . F5 .",
      "A#5 . . . . . F5 . . . D5 . . . A#4 .",
      "C6 . . . . . G5 . . . E5 . . . C5 .",
      "C#6 . . . A5 . . . E5 . . . C#5 . E5 .",
    ),
  },
  stage2: {
    bpm: 160,
    duty: 0.25,
    chords: ["E2", "C3", "D3", "B2", "E2", "C3", "D3", "B2"],
    chordSteps: 16,
    drums: "k.hsk.hsk.hsk.ss",
    loop: true,
    lead: S(
      "E5 . B4 . E5 . F#5 . G5 . F#5 . E5 . B4 .",
      "E5 . C5 . E5 . F#5 . G5 . A5 . G5 . E5 .",
      "F#5 . D5 . F#5 . G5 . A5 . B5 . A5 . F#5 .",
      "D#5 . F#5 . B5 . . . A5 . F#5 . D#5 . B4 .",
      "B5 . . . A5 . G5 . . . E5 . G5 . A5 .",
      "G5 . . . E5 . C5 . . . E5 . G5 . C6 .",
      "A5 . . . F#5 . D5 . . . F#5 . A5 . D6 .",
      "B5 . . . . . . . D#6 . . . B5 . . .",
    ),
  },
  stage3: {
    bpm: 145,
    duty: 0.5,
    chords: ["G2", "E2", "C3", "D3", "G2", "E2", "C3", "D3"],
    chordSteps: 16,
    drums: "k.h.s.h.k.h.s.h.",
    loop: true,
    echo: true,
    lead: S(
      "G5 . D5 . G5 . B5 . A5 . G5 . D5 . B4 .",
      "E5 . B4 . E5 . G5 . F#5 . E5 . B4 . G4 .",
      "C5 . E5 . G5 . C6 . B5 . G5 . E5 . C5 .",
      "D5 . F#5 . A5 . D6 . C6 . A5 . F#5 . D5 .",
      "B5 . . . A5 . B5 . D6 . . . B5 . . .",
      "G5 . . . F#5 . G5 . B5 . . . G5 . . .",
      "E5 . . . D5 . E5 . G5 . . . C6 . . .",
      "A5 . . . . . . . F#5 . G5 . A5 . . .",
    ),
  },
  stage4: {
    bpm: 150,
    duty: 0.25,
    chords: ["C3", "G#2", "A#2", "G2"],
    chordSteps: 16,
    drums: "k.hsk.hsk.hsks.s",
    loop: true,
    lead: S(
      "C5 . D#5 . G5 . C6 . A#5 . G5 . D#5 . G5 .",
      "C5 . D#5 . G#5 . C6 . A#5 . G#5 . D#5 . G#5 .",
      "D5 . F5 . A#5 . D6 . C6 . A#5 . F5 . D5 .",
      "B4 . D5 . G5 . B5 . D6 . . . B5 . G5 .",
    ),
  },
  boss: {
    bpm: 172,
    duty: 0.25,
    chords: ["A2", "A2", "G2", "G2", "F2", "E2"],
    chordSteps: 16,
    drums: "k.sks.sks.sks.ss",
    loop: true,
    lead: S(
      "A5 . A5 . C6 . A5 . D6 . A5 . E6 . D6 .",
      "C6 . A5 . G5 . E5 . A5 . . . . . . .",
      "G5 . G5 . B5 . G5 . C6 . G5 . D6 . C6 .",
      "B5 . G5 . F#5 . D5 . G5 . . . . . . .",
      "F5 . F5 . A5 . F5 . C6 . A5 . F5 . C6 .",
      "E5 . G#5 . B5 . E6 . D6 . B5 . G#5 . E5 .",
    ),
  },
  select: {
    bpm: 128,
    duty: 0.5,
    chords: ["C3", "A2", "F2", "G2"],
    chordSteps: 16,
    drums: "k...h...s...h...",
    loop: true,
    echo: true,
    lead: S(
      "E5 . G5 . C6 . . . B5 . G5 . E5 . . .",
      "C5 . E5 . A5 . . . G5 . E5 . C5 . . .",
      "F5 . A5 . C6 . . . A5 . F5 . C5 . . .",
      "D5 . G5 . B5 . . . D6 . . . B5 . . .",
    ),
  },
  title: {
    bpm: 120,
    duty: 0.25,
    chords: ["A2", "F2", "C3", "G2"],
    chordSteps: 16,
    drums: "k.......s.......",
    loop: true,
    echo: true,
    lead: S(
      "A4 . . . C5 . E5 . . . D5 . C5 . B4 .",
      "A4 . . . C5 . F5 . . . E5 . D5 . C5 .",
      "G4 . . . C5 . E5 . . . G5 . E5 . C5 .",
      "B4 . . . D5 . G5 . . . . . - . . .",
    ),
  },
  victory: {
    bpm: 150,
    duty: 0.5,
    chords: ["C3", "C3", "G2", "C3"],
    chordSteps: 8,
    drums: "k.k.s...",
    loop: false,
    lead: S("G5 . E5 . C5 . G5 . E5 . C5 . G5 . A5 B5 C6 . . . . . . . - . . ."),
  },
  weaponGet: {
    bpm: 132,
    duty: 0.25,
    chords: ["F2", "G2", "E2", "A2"],
    chordSteps: 16,
    drums: "k...s...k.k.s...",
    loop: true,
    echo: true,
    lead: S(
      "C5 . F5 . A5 . . . G5 . F5 . C5 . . .",
      "D5 . G5 . B5 . . . A5 . G5 . D5 . . .",
      "E5 . G#5 . B5 . . . D6 . C6 . B5 . . .",
      "A5 . . . . . . . E5 . . . A4 . . .",
    ),
  },
  gameOver: {
    bpm: 100,
    duty: 0.5,
    chords: ["A2", "F2", "E2", "A2"],
    chordSteps: 8,
    drums: "........",
    loop: false,
    lead: S("E5 . D5 . C5 . B4 . C5 . A4 . . . G#4 . . . A4 . . . . . . . - . . ."),
  },
};

const DRUM_SAMPLES = { k: 1, s: 2, h: 3 } as const;

export class DeliManAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private waves = new Map<number, PeriodicWave>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private song: Song | null = null;
  private songName = "";
  private step = 0;
  private nextAt = 0;
  private muted = false;
  private live: AudioScheduledSourceNode[] = [];

  /** Must be called from a user gesture at least once. */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.musicBus = this.ctx.createGain();
      this.sfxBus = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.musicBus.gain.value = 0.32;
      this.sfxBus.gain.value = 0.6;
      this.musicBus.connect(this.master);
      this.sfxBus.connect(this.master);
      this.master.connect(this.ctx.destination);
      const length = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      let reg = 1;
      for (let i = 0; i < length; i++) {
        // NES-style LFSR noise
        const bit = (reg ^ (reg >> 1)) & 1;
        reg = (reg >> 1) | (bit << 14);
        data[i] = reg & 1 ? 0.8 : -0.8;
      }
      this.timer = setInterval(() => this.schedule(), 25);
    }
    void this.ctx.resume().catch(() => undefined);
  }

  get unlocked() {
    return !!this.ctx;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : 0.5, this.ctx.currentTime, 0.02);
  }

  play(name: keyof typeof SONGS | null) {
    if (name === this.songName && this.song) return;
    this.songName = name ?? "";
    this.song = name ? SONGS[name] : null;
    this.step = 0;
    this.stopLive();
    if (this.ctx) this.nextAt = this.ctx.currentTime + 0.05;
  }

  stopMusic() {
    this.play(null);
  }

  private stopLive() {
    const now = this.ctx?.currentTime ?? 0;
    for (const node of this.live) {
      try {
        node.stop(now + 0.01);
      } catch {
        /* already stopped */
      }
    }
    this.live = [];
  }

  private pulse(duty: number) {
    if (!this.ctx) return null;
    const key = Math.round(duty * 1000);
    let wave = this.waves.get(key);
    if (!wave) {
      const n = 32;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let i = 1; i < n; i++) real[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
      wave = this.ctx.createPeriodicWave(real, imag);
      this.waves.set(key, wave);
    }
    return wave;
  }

  private tone(
    bus: GainNode,
    type: OscillatorType | number,
    note: number,
    at: number,
    length: number,
    volume: number,
    track = false,
  ) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    if (typeof type === "number") osc.setPeriodicWave(this.pulse(type)!);
    else osc.type = type;
    osc.frequency.setValueAtTime(freq(note), at);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, at);
    gain.gain.setValueAtTime(volume * 0.7, at + Math.min(length * 0.5, 0.08));
    gain.gain.linearRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(bus);
    osc.start(at);
    osc.stop(at + length + 0.02);
    if (track) {
      this.live.push(osc);
      osc.onended = () => {
        this.live = this.live.filter((node) => node !== osc);
      };
    }
  }

  private drum(kind: number, at: number, bus: GainNode, volume = 1) {
    if (!this.ctx || !this.noise) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    const length = kind === 1 ? 0.09 : kind === 2 ? 0.14 : 0.03;
    filter.type = kind === 1 ? "lowpass" : kind === 2 ? "bandpass" : "highpass";
    filter.frequency.value = kind === 1 ? 300 : kind === 2 ? 1800 : 7000;
    gain.gain.setValueAtTime(0.5 * volume, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + length);
    src.connect(filter).connect(gain).connect(bus);
    src.start(at, Math.random() * 0.5);
    src.stop(at + length + 0.01);
    if (kind === 1) {
      const osc = this.ctx.createOscillator();
      const og = this.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(140, at);
      osc.frequency.exponentialRampToValueAtTime(40, at + 0.1);
      og.gain.setValueAtTime(0.7 * volume, at);
      og.gain.exponentialRampToValueAtTime(0.001, at + 0.12);
      osc.connect(og).connect(bus);
      osc.start(at);
      osc.stop(at + 0.13);
    }
  }

  private schedule() {
    const ctx = this.ctx;
    const song = this.song;
    if (!ctx || !song || !this.musicBus || ctx.state !== "running") return;
    const stepLen = 60 / song.bpm / 4;
    if (this.nextAt < ctx.currentTime - 0.2) this.nextAt = ctx.currentTime + 0.02;
    while (this.nextAt < ctx.currentTime + 0.12) {
      const total = song.lead.length;
      if (this.step >= total) {
        if (!song.loop) {
          this.song = null;
          return;
        }
        this.step = 0;
      }
      const i = this.step;
      const token = song.lead[i];
      const note = midi(token);
      if (note !== null) {
        let len = 1;
        while (song.lead[i + len] === ".") len++;
        const dur = len * stepLen * 0.95;
        this.tone(this.musicBus, song.duty, note, this.nextAt, dur, 0.22, true);
        if (song.echo)
          this.tone(this.musicBus, 0.5, note, this.nextAt + stepLen * 1.5, Math.max(stepLen, dur - stepLen), 0.06, true);
      }
      const chord = song.chords[Math.floor(i / song.chordSteps) % song.chords.length];
      const root = midi(chord);
      if (root !== null) {
        const octave = i % 2 === 1 ? 12 : 0;
        this.tone(this.musicBus, "triangle", root + octave, this.nextAt, stepLen * 0.9, 0.42, true);
        if (i % song.chordSteps === 0)
          this.tone(this.musicBus, 0.5, root + 24 + 7, this.nextAt, stepLen * 6, 0.05, true);
      }
      const d = song.drums[i % song.drums.length] as keyof typeof DRUM_SAMPLES;
      if (DRUM_SAMPLES[d]) this.drum(DRUM_SAMPLES[d], this.nextAt, this.musicBus, 0.8);
      this.step++;
      this.nextAt += stepLen;
    }
  }

  sfx(name: SfxName) {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus || this.muted) return;
    const t = ctx.currentTime + 0.005;
    const sweep = (type: OscillatorType | number, from: number, to: number, length: number, volume = 0.3) => {
      const osc = ctx.createOscillator();
      if (typeof type === "number") osc.setPeriodicWave(this.pulse(type)!);
      else osc.type = type;
      const gain = ctx.createGain();
      osc.frequency.setValueAtTime(from, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + length);
      gain.gain.setValueAtTime(volume, t);
      gain.gain.linearRampToValueAtTime(0.0001, t + length);
      osc.connect(gain).connect(bus);
      osc.start(t);
      osc.stop(t + length + 0.02);
    };
    const notes = (seq: number[], stepLen: number, duty = 0.5, volume = 0.25) =>
      seq.forEach((n, i) => this.tone(bus, duty, n, t + i * stepLen, stepLen * 0.95, volume));
    switch (name) {
      case "shoot":
        sweep(0.5, 1400, 500, 0.06, 0.18);
        break;
      case "midShot":
        sweep(0.25, 900, 300, 0.12, 0.25);
        break;
      case "bigShot":
        sweep(0.25, 600, 120, 0.22, 0.3);
        this.drum(2, t, bus, 0.6);
        break;
      case "charge":
        sweep(0.125, 300, 1600, 0.35, 0.12);
        break;
      case "chargeHum":
        sweep(0.125, 1500, 1700, 0.05, 0.05);
        break;
      case "hit":
        sweep(0.5, 500, 200, 0.05, 0.2);
        break;
      case "bossHit":
        sweep(0.25, 300, 90, 0.1, 0.3);
        this.drum(2, t, bus, 0.4);
        break;
      case "enemyDie":
      case "explode":
        this.drum(2, t, bus, 0.9);
        this.drum(1, t + 0.03, bus, 0.7);
        sweep("square", 220, 60, 0.18, 0.12);
        break;
      case "tink":
        sweep(0.125, 2400, 2000, 0.05, 0.12);
        break;
      case "hurt":
        sweep(0.5, 700, 120, 0.2, 0.25);
        sweep(0.125, 380, 90, 0.2, 0.15);
        break;
      case "land":
        sweep("triangle", 180, 70, 0.05, 0.35);
        break;
      case "death":
        notes([84, 79, 76, 72, 67, 64, 60, 55], 0.06, 0.25, 0.2);
        break;
      case "pickup":
        notes([84, 88], 0.04, 0.25, 0.15);
        break;
      case "tick":
        sweep(0.25, 1300, 1300, 0.025, 0.08);
        break;
      case "oneUp":
        notes([76, 79, 88, 84, 86, 91], 0.07, 0.25, 0.2);
        break;
      case "door":
        this.drum(1, t, bus, 0.8);
        for (let i = 0; i < 8; i++) this.drum(3, t + i * 0.06, bus, 0.5);
        break;
      case "select":
        notes([72, 79, 84], 0.05, 0.5, 0.2);
        break;
      case "move":
        sweep(0.25, 900, 900, 0.03, 0.12);
        break;
      case "pause":
        notes([84, 79], 0.05, 0.25, 0.18);
        break;
      case "ready":
        notes([72, 76, 79, 84], 0.05, 0.25, 0.12);
        break;
      case "weapon":
        notes([79, 84, 88, 91], 0.04, 0.125, 0.18);
        break;
      case "thud":
        this.drum(1, t, bus, 1);
        this.drum(2, t + 0.02, bus, 0.5);
        break;
      case "honk":
        sweep("sawtooth", 330, 280, 0.12, 0.15);
        break;
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }
}
