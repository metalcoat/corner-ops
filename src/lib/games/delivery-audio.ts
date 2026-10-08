"use client";

type Theme = "menu" | "action";
type DeliverySfx =
  | "start"
  | "steer"
  | "throw"
  | "delivery"
  | "miss"
  | "crash"
  | "yelp"
  | "bark"
  | "meow"
  | "moo"
  | "squish"
  | "ouch"
  | "victory"
  | "gameover"
  | "menu";

export type DeliveryAudioSettings = {
  muted: boolean;
  master: number;
  music: number;
  effects: number;
};

const DEFAULT_SETTINGS: DeliveryAudioSettings = {
  muted: false,
  master: 0.75,
  music: 0.48,
  effects: 0.8,
};

class DeliveryAudioManager {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private menuBus: GainNode | null = null;
  private actionBus: GainNode | null = null;
  private effectsBus: GainNode | null = null;
  private motor: OscillatorNode | null = null;
  private motorGain: GainNode | null = null;
  private timer: number | null = null;
  private nextStepAt = 0;
  private step = 0;
  private intensity = 0;
  private muted = false;
  private theme: Theme = "menu";
  private settings = DEFAULT_SETTINGS;
  private lastPlayed = new Map<DeliverySfx, number>();
  private noiseSeed = 0x51f15e;
  private echo: DelayNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private nextNoise() {
    this.noiseSeed = (this.noiseSeed * 1664525 + 1013904223) >>> 0;
    return this.noiseSeed / 0xffffffff;
  }

  constructor() {
    if (typeof window !== "undefined") {
      try {
        this.settings = {
          ...DEFAULT_SETTINGS,
          ...JSON.parse(
            localStorage.getItem("corner-delivery-audio-v2") || "{}",
          ),
        };
        this.muted = this.settings.muted;
      } catch {}
    }
  }

  private ensureContext() {
    if (typeof window === "undefined") return null;
    if (!this.context) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      const context = new AudioCtor();
      const master = context.createGain();
      const menuBus = context.createGain();
      const actionBus = context.createGain();
      const effectsBus = context.createGain();
      master.gain.value = this.muted ? 0 : this.settings.master;
      menuBus.gain.value = this.settings.music;
      actionBus.gain.value = 0;
      effectsBus.gain.value = this.settings.effects;
      menuBus.connect(master);
      actionBus.connect(master);
      effectsBus.connect(master);
      const motor = context.createOscillator();
      const motorGain = context.createGain();
      motor.type = "triangle";
      motor.frequency.value = 48;
      motorGain.gain.value = 0.0001;
      motor.connect(motorGain);
      motorGain.connect(actionBus);
      motor.start();
      // Glue the mix: a gentle compressor and a short room reverb.
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -16;
      compressor.ratio.value = 3.5;
      compressor.attack.value = 0.006;
      compressor.release.value = 0.18;
      const reverb = context.createConvolver();
      const length = Math.floor(context.sampleRate * 1.1);
      const impulse = context.createBuffer(2, length, context.sampleRate);
      for (let channel = 0; channel < 2; channel++) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++)
          data[i] = (this.nextNoise() * 2 - 1) * Math.pow(1 - i / length, 3);
      }
      reverb.buffer = impulse;
      const wet = context.createGain();
      wet.gain.value = 0.16;
      master.connect(compressor);
      master.connect(reverb);
      reverb.connect(wet);
      wet.connect(compressor);
      compressor.connect(context.destination);
      // A tempo-ish echo for the lead line.
      const echo = context.createDelay(1);
      echo.delayTime.value = 0.32;
      const feedback = context.createGain();
      feedback.gain.value = 0.28;
      const echoOut = context.createGain();
      echoOut.gain.value = 0.35;
      echo.connect(feedback);
      feedback.connect(echo);
      echo.connect(echoOut);
      echoOut.connect(actionBus);
      this.echo = echo;
      this.context = context;
      this.master = master;
      this.menuBus = menuBus;
      this.actionBus = actionBus;
      this.effectsBus = effectsBus;
      this.motor = motor;
      this.motorGain = motorGain;
      this.nextStepAt = context.currentTime + 0.04;
      this.startScheduler();
    }
    if (this.context.state === "suspended") void this.context.resume();
    return this.context;
  }

  private fmNote(
    frequency: number,
    at: number,
    duration: number,
    destination: AudioNode,
    volume: number,
    modulation = 1,
    wave: OscillatorType = "square",
  ) {
    const context = this.context;
    if (!context) return;
    const carrier = context.createOscillator();
    const modulator = context.createOscillator();
    const modDepth = context.createGain();
    const envelope = context.createGain();
    carrier.type = wave;
    carrier.frequency.setValueAtTime(frequency, at);
    modulator.type = "sine";
    modulator.frequency.setValueAtTime(frequency * 2, at);
    modDepth.gain.setValueAtTime(frequency * 0.035 * modulation, at);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(volume, at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    modulator.connect(modDepth);
    modDepth.connect(carrier.frequency);
    carrier.connect(envelope);
    envelope.connect(destination);
    carrier.start(at);
    modulator.start(at);
    carrier.stop(at + duration + 0.02);
    modulator.stop(at + duration + 0.02);
  }

  private noise(at: number, duration: number, volume: number) {
    const context = this.context;
    if (!context || !this.effectsBus) return;
    const frames = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < frames; index++)
      data[index] = this.nextNoise() * 2 - 1;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    source.buffer = buffer;
    filter.type = "lowpass";
    filter.frequency.value = 1250;
    envelope.gain.setValueAtTime(volume, at);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.effectsBus);
    source.start(at);
  }

  /** One shared second of white noise for drums. */
  private noiseSource(at: number, duration: number) {
    const context = this.context!;
    if (!this.noiseBuffer) {
      const frames = context.sampleRate;
      this.noiseBuffer = context.createBuffer(1, frames, context.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = this.nextNoise() * 2 - 1;
    }
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.start(at, Math.random() * 0.5, duration + 0.05);
    return source;
  }

  private drum(at: number, kind: "kick" | "snare" | "ghost" | "hat" | "open" | "clap", out: AudioNode, level = 1) {
    const context = this.context;
    if (!context) return;
    if (kind === "kick") {
      const body = context.createOscillator(),
        env = context.createGain();
      body.type = "sine";
      body.frequency.setValueAtTime(160, at);
      body.frequency.exponentialRampToValueAtTime(42, at + 0.14);
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(0.34 * level, at + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
      body.connect(env);
      env.connect(out);
      body.start(at);
      body.stop(at + 0.34);
      const click = this.noiseSource(at, 0.012),
        clickEnv = context.createGain();
      clickEnv.gain.setValueAtTime(0.08 * level, at);
      clickEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.012);
      click.connect(clickEnv);
      clickEnv.connect(out);
      return;
    }
    const tone = kind === "snare" || kind === "ghost" || kind === "clap";
    const length = kind === "open" ? 0.22 : kind === "hat" ? 0.04 : kind === "clap" ? 0.16 : kind === "ghost" ? 0.06 : 0.18;
    const source = this.noiseSource(at, length),
      filter = context.createBiquadFilter(),
      env = context.createGain();
    filter.type = tone ? "bandpass" : "highpass";
    filter.frequency.value = tone ? 1900 : 7600;
    filter.Q.value = tone ? 0.8 : 0.7;
    const peak = (kind === "snare" ? 0.2 : kind === "clap" ? 0.16 : kind === "ghost" ? 0.05 : kind === "open" ? 0.06 : 0.05) * level;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(peak, at + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(filter);
    filter.connect(env);
    env.connect(out);
    if (kind === "snare") {
      const body = context.createOscillator(),
        bodyEnv = context.createGain();
      body.type = "triangle";
      body.frequency.setValueAtTime(220, at);
      body.frequency.exponentialRampToValueAtTime(150, at + 0.08);
      bodyEnv.gain.setValueAtTime(0.12 * level, at);
      bodyEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
      body.connect(bodyEnv);
      bodyEnv.connect(out);
      body.start(at);
      body.stop(at + 0.12);
    }
  }

  /** A filtered synth voice: detuned oscillators through a moving lowpass. */
  private voice(
    midi: number,
    at: number,
    duration: number,
    out: AudioNode,
    o: { wave: OscillatorType; level: number; cutoff: number; sweep?: number; detune?: number; vibrato?: boolean; attack?: number },
  ) {
    const context = this.context;
    if (!context) return;
    const frequency = 440 * Math.pow(2, (midi - 69) / 12),
      filter = context.createBiquadFilter(),
      env = context.createGain();
    filter.type = "lowpass";
    filter.Q.value = 4;
    filter.frequency.setValueAtTime(o.cutoff * (o.sweep ?? 1), at);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, o.cutoff), at + Math.min(duration, 0.18));
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(o.level, at + (o.attack ?? 0.006));
    env.gain.setTargetAtTime(o.level * 0.6, at + 0.03, duration * 0.4);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    filter.connect(env);
    env.connect(out);
    for (const cents of o.detune ? [-o.detune, o.detune] : [0]) {
      const osc = context.createOscillator();
      osc.type = o.wave;
      osc.frequency.setValueAtTime(frequency, at);
      osc.detune.value = cents;
      if (o.vibrato && duration > 0.2) {
        const lfo = context.createOscillator(),
          depth = context.createGain();
        lfo.frequency.value = 5.5;
        depth.gain.setValueAtTime(0, at);
        depth.gain.linearRampToValueAtTime(frequency * 0.012, at + duration * 0.6);
        lfo.connect(depth);
        depth.connect(osc.frequency);
        lfo.start(at);
        lfo.stop(at + duration + 0.05);
      }
      osc.connect(filter);
      osc.start(at);
      osc.stop(at + duration + 0.05);
    }
  }

  // A sixteen-bar song: two progressions with a hooky lead, 16 steps a bar.
  private static readonly CHORDS = [
    [60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62],
    [60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62],
    [53, 57, 60], [55, 59, 62], [52, 55, 59], [57, 60, 64],
    [53, 57, 60], [55, 59, 62], [60, 64, 67], [55, 59, 62],
  ];
  private static readonly LEAD: (number | null)[][] = [
    [72, null, 76, null, 79, null, 76, 74, 72, null, null, 74, 76, null, 79, null],
    [81, null, 79, null, 76, null, 74, 72, 74, null, 76, null, null, 72, 69, null],
    [77, null, 76, null, 74, null, 72, null, 69, null, 72, 74, 77, null, 76, null],
    [74, null, 76, 77, 79, null, null, 77, 76, null, 74, null, 71, null, 74, null],
    [72, null, 76, null, 79, null, 84, null, 83, null, 79, null, 76, null, 79, null],
    [81, null, 79, 81, 84, null, 81, null, 79, null, 76, null, 74, null, 76, null],
    [77, null, 81, null, 84, null, 81, 79, 77, null, 76, null, 74, null, 72, null],
    [74, 76, 77, 79, 81, null, 79, null, 77, null, 74, null, 79, null, null, null],
    [72, null, 69, null, 72, null, 74, null, 77, null, 76, null, 74, null, 72, null],
    [74, null, 71, null, 74, null, 76, null, 79, null, 77, null, 76, null, 74, null],
    [76, null, 72, null, 71, null, 72, null, 76, null, 79, null, 83, null, 79, null],
    [81, null, null, 79, 76, null, 72, null, 76, null, 79, null, 81, null, null, null],
    [77, null, 77, 79, 81, null, 77, null, 72, null, 77, null, 81, null, 84, null],
    [83, null, 81, null, 79, null, 77, null, 74, null, 79, null, 83, null, 86, null],
    [84, null, null, null, 79, null, 76, null, 72, null, 76, null, 79, null, 84, null],
    [83, null, 79, null, 77, null, 74, null, 71, null, 74, null, 79, null, null, null],
  ];

  private scheduleStep(at: number) {
    if (!this.menuBus || !this.actionBus) return;
    const step = this.step % 256,
      bar = Math.floor(step / 16),
      beat = step % 16,
      chord = DeliveryAudioManager.CHORDS[bar],
      root = chord[0] - 24,
      urgent = this.intensity > 0.62,
      action = this.actionBus,
      menu = this.menuBus;

    // ---- action theme: driving funk ----
    if ([0, 7, 8, 10].includes(beat) || (urgent && beat === 14)) this.drum(at, "kick", action, beat === 0 ? 1 : 0.8);
    if (beat === 4 || beat === 12) this.drum(at, "snare", action);
    if (beat === 12 && bar % 4 === 3) this.drum(at, "clap", action);
    if ([3, 6, 9, 15].includes(beat)) this.drum(at, "ghost", action);
    if (beat % 2 === 0) this.drum(at, beat % 4 === 2 ? "open" : "hat", action, beat % 4 === 0 ? 0.8 : 1);
    else if (urgent || bar >= 8) this.drum(at, "hat", action, 0.6);
    // Bass: root, octave pops and walk-ups.
    const bassLine = [0, null, 12, null, 0, 0, null, 7, 0, null, 12, 10, null, 7, 5, null];
    const bassNote = bassLine[beat];
    if (bassNote !== null)
      this.voice(root + bassNote, at, beat % 4 === 0 ? 0.22 : 0.13, action, { wave: "sawtooth", level: 0.16, cutoff: 420, sweep: 4, detune: 6 });
    // Offbeat chord stabs.
    if (beat % 4 === 2)
      for (const note of chord) this.voice(note, at, 0.12, action, { wave: "square", level: 0.035, cutoff: 1800, sweep: 2, detune: 8 });
    // The hook.
    const lead = DeliveryAudioManager.LEAD[bar][beat];
    if (lead !== null) {
      let length = 1;
      while (beat + length < 16 && DeliveryAudioManager.LEAD[bar][beat + length] === null && length < 4) length++;
      const duration = (length * 60) / (112 + this.intensity * 40) / 4;
      this.voice(lead, at, duration * 0.95, action, { wave: "square", level: 0.07, cutoff: 2600, sweep: 1.5, detune: 5, vibrato: true });
      if (this.echo) this.voice(lead, at, duration * 0.9, this.echo, { wave: "triangle", level: 0.05, cutoff: 2200 });
      if (urgent) this.voice(lead + 12, at, duration * 0.6, action, { wave: "triangle", level: 0.025, cutoff: 3000 });
    }

    // ---- menu theme: mellow electric piano over a soft beat ----
    if (beat === 0) this.drum(at, "kick", menu, 0.5);
    if (beat === 8) this.drum(at, "snare", menu, 0.35);
    if (beat % 4 === 2) this.drum(at, "hat", menu, 0.5);
    if (beat === 0 || beat === 10) this.voice(root + 12, at, 0.4, menu, { wave: "triangle", level: 0.1, cutoff: 600 });
    if (beat % 2 === 0) {
      const arp = [0, 1, 2, 1][(beat / 2) % 4];
      this.voice(chord[arp] + 12, at, 0.35, menu, { wave: "sine", level: 0.06, cutoff: 3000, attack: 0.004 });
      this.voice(chord[arp] + 24, at, 0.2, menu, { wave: "triangle", level: 0.015, cutoff: 3000 });
    }
    this.step += 1;
  }

  private startScheduler() {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      const context = this.context;
      if (!context) return;
      while (this.nextStepAt < context.currentTime + 0.12) {
        this.scheduleStep(this.nextStepAt);
        const bpm = 112 + this.intensity * 40;
        // A little swing on the off-sixteenths.
        this.nextStepAt += (60 / bpm / 4) * (this.step % 2 ? 1.12 : 0.88);
      }
    }, 25);
  }

  transition(theme: Theme) {
    const context = this.ensureContext();
    if (!context || !this.menuBus || !this.actionBus) return;
    this.theme = theme;
    const at = context.currentTime;
    this.menuBus.gain.cancelScheduledValues(at);
    this.actionBus.gain.cancelScheduledValues(at);
    this.menuBus.gain.setTargetAtTime(
      theme === "menu" ? this.settings.music : 0.0001,
      at,
      0.22,
    );
    this.actionBus.gain.setTargetAtTime(
      theme === "action" ? this.settings.music : 0.0001,
      at,
      0.22,
    );
  }

  setIntensity(speedRatio: number, urgencyRatio: number) {
    this.intensity = Math.max(
      0,
      Math.min(1, speedRatio * 0.62 + urgencyRatio * 0.38),
    );
    if (this.context && this.motor && this.motorGain) {
      const at = this.context.currentTime;
      this.motor.frequency.setTargetAtTime(48 + this.intensity * 94, at, 0.08);
      this.motorGain.gain.setTargetAtTime(
        0.012 + this.intensity * 0.025,
        at,
        0.08,
      );
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.settings.muted = muted;
    this.persist();
    if (this.master && this.context)
      this.master.gain.setTargetAtTime(
        muted ? 0 : this.settings.master,
        this.context.currentTime,
        0.04,
      );
  }

  getSettings() {
    return { ...this.settings };
  }

  setLevels(levels: Partial<Omit<DeliveryAudioSettings, "muted">>) {
    this.settings = { ...this.settings, ...levels };
    this.persist();
    if (!this.context) return;
    const at = this.context.currentTime;
    this.master?.gain.setTargetAtTime(
      this.muted ? 0 : this.settings.master,
      at,
      0.04,
    );
    this.effectsBus?.gain.setTargetAtTime(this.settings.effects, at, 0.04);
    this.menuBus?.gain.setTargetAtTime(
      this.theme === "menu" ? this.settings.music : 0.0001,
      at,
      0.04,
    );
    this.actionBus?.gain.setTargetAtTime(
      this.theme === "action" ? this.settings.music : 0.0001,
      at,
      0.04,
    );
  }

  private persist() {
    if (typeof window !== "undefined")
      localStorage.setItem(
        "corner-delivery-audio-v2",
        JSON.stringify(this.settings),
      );
  }

  suspend() {
    if (this.context?.state === "running") void this.context.suspend();
  }

  resume() {
    if (this.context?.state === "suspended") void this.context.resume();
  }

  play(effect: DeliverySfx) {
    const context = this.ensureContext();
    if (!context || !this.effectsBus || this.muted) return;
    const at = context.currentTime;
    const cooldown = effect === "steer" ? 180 : effect === "crash" ? 90 : 25;
    const now = performance.now();
    if (now - (this.lastPlayed.get(effect) || 0) < cooldown) return;
    this.lastPlayed.set(effect, now);
    const out = this.effectsBus;
    if (effect === "start") {
      this.noise(at, 0.18, 0.11);
      [58, 72, 96, 131, 196].forEach((note, index) =>
        this.fmNote(note, at + index * 0.08, 0.18, out, 0.13, 1.4, "triangle"),
      );
    } else if (effect === "steer") {
      this.noise(at, 0.07, 0.035);
      this.fmNote(118, at, 0.08, out, 0.045, 0.7, "triangle");
    } else if (effect === "throw") {
      const oscillator = context.createOscillator();
      const filter = context.createBiquadFilter();
      const envelope = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(520, at);
      oscillator.frequency.exponentialRampToValueAtTime(180, at + 0.13);
      filter.type = "bandpass";
      filter.frequency.value = 720;
      envelope.gain.setValueAtTime(0.12, at);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      oscillator.connect(filter);
      filter.connect(envelope);
      envelope.connect(out);
      oscillator.start(at);
      oscillator.stop(at + 0.15);
    } else if (effect === "delivery") {
      [523.25, 659.25, 783.99, 1046.5].forEach((note, index) =>
        this.fmNote(note, at + index * 0.055, 0.16, out, 0.12, 1.15),
      );
    } else if (effect === "miss") {
      this.noise(at, 0.09, 0.07);
      [294, 247, 196].forEach((note, index) =>
        this.fmNote(note, at + index * 0.06, 0.13, out, 0.07, 0.6, "triangle"),
      );
    } else if (effect === "crash") {
      this.noise(at, 0.38, 0.38);
      this.fmNote(95, at, 0.35, out, 0.2, 2.4, "sawtooth");
    } else if (effect === "yelp") {
      this.fmNote(430, at, 0.1, out, 0.16, 1.6, "sawtooth");
      this.fmNote(780, at + 0.07, 0.18, out, 0.18, 2, "triangle");
    } else if (effect === "bark") {
      this.noise(at, 0.08, 0.2);
      this.fmNote(185, at, 0.09, out, 0.19, 2.2, "sawtooth");
      this.noise(at + 0.12, 0.07, 0.17);
      this.fmNote(155, at + 0.12, 0.1, out, 0.17, 2, "sawtooth");
    } else if (effect === "meow") {
      this.fmNote(620, at, 0.15, out, 0.16, 1.8, "triangle");
      this.fmNote(870, at + 0.1, 0.2, out, 0.13, 2.4, "sine");
    } else if (effect === "moo") {
      this.fmNote(105, at, 0.42, out, 0.22, 3.2, "sawtooth");
      this.fmNote(82, at + 0.24, 0.5, out, 0.2, 2.6, "triangle");
    } else if (effect === "squish") {
      this.noise(at, 0.09, 0.28);
      this.fmNote(240, at, 0.08, out, 0.2, 3.4, "square");
      this.fmNote(72, at + 0.055, 0.2, out, 0.24, 1.7, "sawtooth");
    } else if (effect === "ouch") {
      const voice = new SpeechSynthesisUtterance("Ouch!");
      voice.rate = 1.35;
      voice.pitch = 1.1;
      voice.volume = 0.8;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(voice);
    } else if (effect === "gameover") {
      [196, 165, 131, 98, 73].forEach((note, index) =>
        this.fmNote(note, at + index * 0.11, 0.25, out, 0.13, 1.2, "triangle"),
      );
      this.noise(at + 0.48, 0.24, 0.1);
    } else if (effect === "menu") {
      this.fmNote(440, at, 0.045, out, 0.05, 0.5, "triangle");
    } else {
      [261.63, 329.63, 392, 523.25, 659.25, 783.99, 1046.5].forEach(
        (note, index) =>
          this.fmNote(
            note,
            at + index * 0.09,
            0.32,
            out,
            0.15,
            1.35,
            index % 2 ? "triangle" : "square",
          ),
      );
    }
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.context) void this.context.close();
    this.context = null;
    this.master = null;
    this.menuBus = null;
    this.actionBus = null;
    this.effectsBus = null;
    this.motor = null;
    this.motorGain = null;
    this.step = 0;
  }
}

export const deliveryAudio = new DeliveryAudioManager();
