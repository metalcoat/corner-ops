// Notification sounds, synthesized sample by sample from models of real
// instruments rather than plain beeps: struck metal and wood are sums of their
// measured (inharmonic) vibration modes, each with its own decay, a little
// detuning between the two sides of a bell for natural shimmer, and a short
// noise "strike" for the hammer, mallet, or clapper. Plucked strings use
// Karplus–Strong. Pure functions (no browser APIs) so they're unit-tested; the
// POS adds a small-room reverb when it plays them.

export const ALERT_SOUNDS = [
  { id: "service_bell", label: "Counter service bell", group: "Bells" },
  { id: "kitchen_bell", label: "Kitchen order-up bell (3 dings)", group: "Bells" },
  { id: "warm_chime", label: "Door chime (ding-dong)", group: "Bells" },
  { id: "gentle_bell", label: "Hand bell", group: "Bells" },
  { id: "register_chime", label: "Cash register", group: "Bells" },
  { id: "phone_ring", label: "Classic telephone ring", group: "Bells" },
  { id: "glass_ping", label: "Glass tap", group: "Bells" },
  { id: "marimba", label: "Marimba", group: "Instruments" },
  { id: "vibraphone", label: "Vibraphone", group: "Instruments" },
  { id: "music_box", label: "Music box", group: "Instruments" },
  { id: "harp", label: "Harp", group: "Instruments" },
  { id: "piano", label: "Soft piano", group: "Instruments" },
  { id: "steel_drum", label: "Steel drum", group: "Instruments" },
  { id: "mellow_horn", label: "Soft horn", group: "Instruments" },
  { id: "wooden_tap", label: "Wood block knock", group: "Subtle" },
] as const;
export type AlertSoundId = (typeof ALERT_SOUNDS)[number]["id"];

type Stereo = { left: Float32Array; right: Float32Array };

/** Deterministic noise so every device renders the same sound. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

class Canvas {
  readonly left: Float32Array;
  readonly right: Float32Array;
  constructor(readonly rate: number, seconds: number) {
    const n = Math.ceil(rate * seconds);
    this.left = new Float32Array(n);
    this.right = new Float32Array(n);
  }

  /**
   * One vibration mode: a sine that rings down exponentially (tau = seconds to
   * fall to 37%), with a short attack so it never clicks. `pan` −1…1, `beat`
   * splits the mode into two slightly different frequencies (Hz apart) like a
   * real bell that isn't perfectly round.
   */
  mode(at: number, freq: number, amp: number, tau: number, o: { pan?: number; beat?: number; attack?: number; tremolo?: [number, number]; glide?: number } = {}) {
    if (freq <= 0 || freq >= this.rate / 2 || amp === 0) return;
    const start = Math.floor(at * this.rate);
    // e^-6 (−52 dB) is inaudible under everything else.
    const length = Math.min(this.left.length - start, Math.ceil(tau * 6 * this.rate));
    const pan = o.pan ?? 0, gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
    const attack = Math.max(1, Math.floor((o.attack ?? 0.002) * this.rate));
    const beat = o.beat ?? 0;
    const [tremRate, tremDepth] = o.tremolo ?? [0, 0];
    const glide = o.glide ?? 0;
    const decay = Math.exp(-1 / (tau * this.rate));
    // Phasor rotation (no sin() per sample) unless the pitch glides.
    const stepA = (2 * Math.PI * (freq + beat / 2)) / this.rate, stepB = (2 * Math.PI * (freq - beat / 2)) / this.rate;
    const ca = Math.cos(stepA), sa = Math.sin(stepA), cb = Math.cos(stepB), sb = Math.sin(stepB);
    let xa = 1, ya = 0, xb = 1, yb = 0, phase = 0, env = amp;
    for (let i = 0; i < length; i++) {
      let value: number;
      if (glide) {
        phase += (2 * Math.PI * freq * (1 + glide * Math.exp(-i / (0.03 * this.rate)))) / this.rate;
        value = Math.sin(phase);
      } else {
        const nxa = xa * ca - ya * sa;
        ya = xa * sa + ya * ca;
        xa = nxa;
        if (beat) {
          const nxb = xb * cb - yb * sb;
          yb = xb * sb + yb * cb;
          xb = nxb;
          value = 0.5 * (ya + yb);
        } else value = ya;
      }
      let gain = env * (i < attack ? i / attack : 1);
      if (tremDepth) gain *= 1 - tremDepth * (0.5 + 0.5 * Math.sin((2 * Math.PI * tremRate * i) / this.rate));
      env *= decay;
      this.left[start + i] += value * gain * gl;
      this.right[start + i] += value * gain * gr;
    }
  }

  /** A filtered noise burst: the hammer, mallet, or knuckle hitting something. */
  strike(at: number, seconds: number, amp: number, center: number, q: number, seed: number, pan = 0) {
    const start = Math.floor(at * this.rate), n = Math.min(this.left.length - start, Math.ceil(seconds * this.rate));
    const noise = rng(seed);
    // RBJ band-pass biquad.
    const w = (2 * Math.PI * Math.min(center, this.rate * 0.45)) / this.rate, alpha = Math.sin(w) / (2 * q);
    const b0 = alpha, b2 = -alpha, a0 = 1 + alpha, a1 = -2 * Math.cos(w), a2 = 1 - alpha;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < n; i++) {
      const x = noise() * amp * Math.exp((-i / n) * 5);
      const y = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      this.left[start + i] += y * gl;
      this.right[start + i] += y * gr;
    }
  }

  /** Karplus–Strong plucked string. */
  pluck(at: number, freq: number, amp: number, seconds: number, brightness: number, seed: number, pan = 0) {
    const start = Math.floor(at * this.rate), n = Math.min(this.left.length - start, Math.ceil(seconds * this.rate));
    const period = this.rate / freq, size = Math.floor(period), frac = period - size;
    const line = new Float32Array(size + 2), noise = rng(seed);
    // A softer pluck: lowpassed noise burst as the initial string shape.
    let last = 0;
    for (let i = 0; i < line.length; i++) {
      last = last + brightness * (noise() - last);
      line[i] = last;
    }
    const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
    let index = 0;
    const loss = 0.996 + 0.0035 * (1 - Math.min(1, freq / 1500));
    for (let i = 0; i < n; i++) {
      const a = line[index % line.length], b = line[(index + 1) % line.length];
      const out = a + (b - a) * frac;
      line[index % line.length] = loss * 0.5 * (a + b);
      index++;
      const env = Math.min(1, i / (this.rate * 0.002));
      this.left[start + i] += out * amp * env * gl;
      this.right[start + i] += out * amp * env * gr;
    }
  }

  normalize(peak = 0.89): Stereo {
    let max = 0;
    for (let i = 0; i < this.left.length; i++) max = Math.max(max, Math.abs(this.left[i]), Math.abs(this.right[i]));
    if (max > 0) {
      const gain = peak / max;
      for (let i = 0; i < this.left.length; i++) {
        this.left[i] *= gain;
        this.right[i] *= gain;
      }
    }
    // Fade the last 30 ms so nothing is cut off with a click.
    const fade = Math.floor(this.rate * 0.03);
    for (let i = 0; i < fade; i++) {
      const g = i / fade, j = this.left.length - 1 - i;
      this.left[j] *= g;
      this.right[j] *= g;
    }
    return { left: this.left, right: this.right };
  }
}

const NOTE = (name: string) => {
  const m = /^([A-G])(#|b)?(\d)$/.exec(name)!;
  const steps = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1] as "C"]! + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return 440 * 2 ** ((steps + (Number(m[3]) - 4) * 12) / 12);
};

// Measured partial ratios for real objects (approximate, from published acoustics data).
const SERVICE_BELL: Array<[number, number, number]> = [[1, 1, 2.4], [2.32, 0.55, 1.5], [4.25, 0.32, 0.9], [6.63, 0.2, 0.55], [9.38, 0.11, 0.35], [12.6, 0.06, 0.22]];
const TUBULAR: Array<[number, number, number]> = [[1, 0.35, 2.6], [2.756, 1, 2.2], [5.404, 0.55, 1.3], [8.933, 0.28, 0.75], [13.34, 0.12, 0.45]];
const HANDBELL: Array<[number, number, number]> = [[0.5, 0.35, 3], [1, 1, 2.2], [1.19, 0.35, 1.6], [1.5, 0.22, 1.2], [2, 0.45, 1.0], [2.52, 0.12, 0.6], [3.01, 0.08, 0.4]];

function bell(c: Canvas, at: number, f: number, amp: number, partials: Array<[number, number, number]>, opts: { pan?: number; decay?: number; seed: number; strike?: number }) {
  for (const [ratio, level, tau] of partials) c.mode(at, f * ratio, amp * level, tau * (opts.decay ?? 1), { pan: opts.pan, beat: 0.6 + ratio * 0.35, attack: 0.0015 });
  c.strike(at, 0.006, amp * (opts.strike ?? 0.5), Math.min(9000, f * 3), 0.9, opts.seed, opts.pan);
}

function bar(c: Canvas, at: number, f: number, amp: number, ratios: Array<[number, number, number]>, opts: { pan?: number; seed: number; mallet?: number; tremolo?: [number, number] }) {
  for (const [ratio, level, tau] of ratios) c.mode(at, f * ratio, amp * level, tau, { pan: opts.pan, attack: 0.003, tremolo: opts.tremolo });
  c.strike(at, 0.012, amp * (opts.mallet ?? 0.35), f * 1.5, 1.2, opts.seed, opts.pan);
}

function pianoNote(c: Canvas, at: number, f: number, amp: number, seed: number, pan = 0) {
  const B = 0.00035;
  for (let n = 1; n <= 10; n++) {
    const fn = n * f * Math.sqrt(1 + B * n * n);
    const level = amp / n ** 1.25, tau = 2.4 / (1 + 0.45 * n) * (f > 600 ? 0.7 : 1);
    // Unison strings slightly out of tune with each other: the slow beating is what makes a piano sound alive.
    c.mode(at, fn, level, tau, { pan, attack: 0.004, beat: fn * 0.0009 });
  }
  c.strike(at, 0.02, amp * 0.12, 1800, 0.7, seed, pan);
}

/** Renders a sound to stereo samples at the given rate. */
export function renderAlertSound(id: AlertSoundId | string, rate = 44100): Stereo {
  switch (id) {
    case "service_bell": {
      const c = new Canvas(rate, 2.6);
      bell(c, 0.01, 1830, 0.9, SERVICE_BELL, { seed: 11, strike: 0.7 });
      return c.normalize();
    }
    case "kitchen_bell": {
      const c = new Canvas(rate, 2.4);
      [0.01, 0.2, 0.39].forEach((t, i) => bell(c, t, 1830, i === 2 ? 0.95 : 0.8, SERVICE_BELL, { seed: 21 + i, strike: 0.7, pan: (i - 1) * 0.15 }));
      return c.normalize();
    }
    case "warm_chime": {
      const c = new Canvas(rate, 3.4);
      bell(c, 0.01, NOTE("E5") / 2.756, 1, TUBULAR, { seed: 31, pan: -0.25, strike: 0.25 });
      bell(c, 0.62, NOTE("C5") / 2.756, 1, TUBULAR, { seed: 32, pan: 0.25, strike: 0.25 });
      return c.normalize();
    }
    case "gentle_bell": {
      const c = new Canvas(rate, 3.2);
      bell(c, 0.01, NOTE("D6") / 2, 0.9, HANDBELL, { seed: 41, strike: 0.15, decay: 0.9, pan: -0.15 });
      bell(c, 0.55, NOTE("F#6") / 2, 0.8, HANDBELL, { seed: 42, strike: 0.15, decay: 0.9, pan: 0.15 });
      return c.normalize();
    }
    case "register_chime": {
      const c = new Canvas(rate, 2.2);
      // Drawer release clunk, coins, then the bell.
      c.strike(0.01, 0.07, 1.2, 180, 0.8, 51);
      c.mode(0.01, 140, 0.6, 0.06);
      c.mode(0.012, 310, 0.35, 0.04);
      const noise = rng(52);
      for (let i = 0; i < 9; i++) {
        const t = 0.05 + i * 0.022 + Math.abs(noise()) * 0.02, f = 4200 + Math.abs(noise()) * 4500;
        c.mode(t, f, 0.12, 0.05, { pan: noise() * 0.6 });
        c.mode(t, f * 1.47, 0.05, 0.03, { pan: noise() * 0.6 });
      }
      bell(c, 0.16, 2350, 0.85, SERVICE_BELL, { seed: 53, strike: 0.5, decay: 0.75 });
      return c.normalize();
    }
    case "phone_ring": {
      // An electromechanical ringer: a hammer swinging ~20×/s between two bells.
      const c = new Canvas(rate, 2.4);
      const gongs: Array<[number, number, number]> = [[1, 1, 0.5], [2.41, 0.45, 0.3], [4.62, 0.2, 0.18]];
      for (const burst of [0, 1.15]) {
        for (let k = 0; k < 18; k++) {
          const t = burst + 0.01 + k / 20.5;
          const f = k % 2 ? 1180 : 1265;
          for (const [r, l, tau] of gongs) c.mode(t, f * r, 0.32 * l, tau * 0.35, { pan: k % 2 ? 0.3 : -0.3, beat: 1.4, attack: 0.001 });
          c.strike(t, 0.003, 0.25, 3500, 1.2, 60 + k, k % 2 ? 0.3 : -0.3);
        }
      }
      return c.normalize(0.8);
    }
    case "glass_ping": {
      const c = new Canvas(rate, 2.4);
      for (const [t, f, p] of [[0.01, 1318, -0.2], [0.42, 1760, 0.2]] as const) {
        for (const [r, l, tau] of [[1, 1, 1.4], [2.32, 0.25, 0.6], [4.17, 0.07, 0.25]] as const) c.mode(t, f * r, 0.7 * l, tau, { pan: p, beat: 0.9, attack: 0.001 });
        c.strike(t, 0.003, 0.3, 6000, 1.5, Math.round(f), p);
      }
      return c.normalize(0.8);
    }
    case "marimba": {
      const c = new Canvas(rate, 1.8);
      const r: Array<[number, number, number]> = [[1, 1, 0.55], [3.93, 0.32, 0.13], [9.2, 0.06, 0.04]];
      [["C5", 0], ["E5", 0.13], ["G5", 0.26], ["C6", 0.42]].forEach(([n, t], i) => bar(c, t as number, NOTE(n as string), 0.8, r, { seed: 70 + i, pan: -0.3 + i * 0.2, mallet: 0.5 }));
      return c.normalize();
    }
    case "vibraphone": {
      const c = new Canvas(rate, 3.2);
      const r: Array<[number, number, number]> = [[1, 1, 2.2], [3.98, 0.18, 0.5], [10.9, 0.04, 0.12]];
      [["A4", 0], ["C#5", 0.18], ["E5", 0.36]].forEach(([n, t], i) => bar(c, t as number, NOTE(n as string), 0.7, r, { seed: 80 + i, pan: -0.25 + i * 0.25, mallet: 0.15, tremolo: [5.6, 0.35] }));
      return c.normalize();
    }
    case "music_box": {
      const c = new Canvas(rate, 2.6);
      const tine: Array<[number, number, number]> = [[1, 1, 1.1], [5.4, 0.12, 0.2], [14.2, 0.03, 0.05]];
      [["E6", 0], ["G6", 0.16], ["C7", 0.32], ["B6", 0.6], ["G6", 0.76]].forEach(([n, t], i) => bar(c, t as number, NOTE(n as string), 0.6, tine, { seed: 90 + i, pan: Math.sin(i) * 0.3, mallet: 0.12 }));
      return c.normalize();
    }
    case "harp": {
      const c = new Canvas(rate, 2.6);
      [["G4", 0], ["B4", 0.09], ["D5", 0.18], ["G5", 0.27], ["B5", 0.36]].forEach(([n, t], i) => c.pluck(t as number, NOTE(n as string), 0.7, 2.4 - (t as number), 0.45, 100 + i, -0.4 + i * 0.2));
      return c.normalize();
    }
    case "piano": {
      const c = new Canvas(rate, 2.8);
      [["F4", 0, -0.2], ["A4", 0.07, 0], ["C5", 0.14, 0.15], ["F5", 0.24, 0.25]].forEach(([n, t, p], i) => pianoNote(c, t as number, NOTE(n as string), 0.6, 110 + i, p as number));
      return c.normalize();
    }
    case "steel_drum": {
      const c = new Canvas(rate, 1.9);
      const pan: Array<[number, number, number]> = [[1, 1, 0.65], [2, 0.6, 0.45], [3, 0.25, 0.3], [4.02, 0.12, 0.18]];
      [["D5", 0], ["F#5", 0.14], ["A5", 0.28]].forEach(([n, t], i) => {
        const f = NOTE(n as string);
        for (const [r, l, tau] of pan) c.mode(t as number, f * r, 0.7 * l, tau, { pan: -0.2 + i * 0.2, glide: 0.012, attack: 0.002 });
        c.strike(t as number, 0.01, 0.3, f * 2, 1, 120 + i);
      });
      return c.normalize();
    }
    case "mellow_horn": {
      // A soft French-horn-like swell: harmonics that brighten as it swells, with gentle vibrato.
      const c = new Canvas(rate, 2.0);
      for (const [n, at, pan] of [["F4", 0.01, -0.15], ["C5", 0.01, 0.15]] as const) {
        const f = NOTE(n), start = Math.floor(at * rate), len = Math.floor(1.6 * rate);
        let phase = 0;
        for (let i = 0; i < len; i++) {
          const t = i / rate, env = Math.min(1, t / 0.12) * Math.exp(-Math.max(0, t - 0.5) / 0.35);
          const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5 * t) * Math.min(1, t / 0.4);
          phase += (2 * Math.PI * f * vib) / rate;
          let v = 0;
          for (let h = 1; h <= 8; h++) v += (Math.sin(phase * h) / h ** (2.2 - env * 0.8)) * (h > 4 ? env : 1);
          const s = v * env * 0.3, gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
          c.left[start + i] += s * gl;
          c.right[start + i] += s * gr;
        }
        c.strike(at, 0.08, 0.04, 1200, 0.5, 130);
      }
      return c.normalize(0.8);
    }
    case "wooden_tap":
    default: {
      const c = new Canvas(rate, 0.9);
      // A hollow wood block: two short resonances excited by a knuckle/mallet click.
      for (const [t, f, p] of [[0.01, 820, -0.2], [0.2, 1040, 0.2]] as const) {
        c.mode(t, f, 1, 0.06, { pan: p, attack: 0.0008 });
        c.mode(t, f * 1.58, 0.45, 0.035, { pan: p, attack: 0.0008 });
        c.mode(t, f * 2.6, 0.18, 0.02, { pan: p, attack: 0.0008 });
        c.strike(t, 0.008, 0.9, f * 1.2, 2, Math.round(f), p);
      }
      return c.normalize();
    }
  }
}

/**
 * A small room's echo (exponentially decaying, darkening noise) for a
 * ConvolverNode, so sounds feel like they're in the deli, not in headphones.
 */
export function roomImpulse(rate = 44100, seconds = 0.9): Stereo {
  const n = Math.floor(rate * seconds), left = new Float32Array(n), right = new Float32Array(n);
  const a = rng(7), b = rng(8);
  let lpL = 0, lpR = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate, decay = Math.exp(-t / 0.22), k = 0.55 - 0.45 * (i / n);
    lpL += k * (a() - lpL);
    lpR += k * (b() - lpR);
    // A gap before the first reflections, like a real room.
    const pre = t < 0.008 ? 0 : 1;
    left[i] = lpL * decay * pre;
    right[i] = lpR * decay * pre;
  }
  return { left, right };
}
