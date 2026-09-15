"use client";

type Theme = "menu" | "action";
type DeliverySfx =
  | "throw"
  | "delivery"
  | "crash"
  | "yelp"
  | "bark"
  | "meow"
  | "moo"
  | "squish"
  | "ouch"
  | "victory";

class DeliveryAudioManager {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private menuBus: GainNode | null = null;
  private actionBus: GainNode | null = null;
  private motor: OscillatorNode | null = null;
  private motorGain: GainNode | null = null;
  private timer: number | null = null;
  private nextStepAt = 0;
  private step = 0;
  private intensity = 0;
  private muted = false;

  private ensureContext() {
    if (typeof window === "undefined") return null;
    if (!this.context) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      const context = new AudioCtor();
      const master = context.createGain();
      const menuBus = context.createGain();
      const actionBus = context.createGain();
      master.gain.value = this.muted ? 0 : 0.7;
      menuBus.gain.value = 1;
      actionBus.gain.value = 0;
      menuBus.connect(master);
      actionBus.connect(master);
      const motor = context.createOscillator();
      const motorGain = context.createGain();
      motor.type = "triangle";
      motor.frequency.value = 48;
      motorGain.gain.value = 0.0001;
      motor.connect(motorGain);
      motorGain.connect(actionBus);
      motor.start();
      master.connect(context.destination);
      this.context = context;
      this.master = master;
      this.menuBus = menuBus;
      this.actionBus = actionBus;
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
    if (!context || !this.master) return;
    const frames = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < frames; index++)
      data[index] = Math.random() * 2 - 1;
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
    envelope.connect(this.master);
    source.start(at);
  }

  private scheduleStep(at: number) {
    if (!this.menuBus || !this.actionBus) return;
    const menuLead = [261.63, 329.63, 392, 329.63, 293.66, 349.23, 440, 349.23];
    const actionLead = [329.63, 392, 493.88, 659.25, 587.33, 493.88, 440, 392];
    const actionBass = [82.41, 82.41, 98, 110, 73.42, 73.42, 98, 123.47];
    const position = this.step % 16;
    const modulation = 0.8 + this.intensity * 1.7;
    if (position % 2 === 0) {
      this.fmNote(
        menuLead[(position / 2) % menuLead.length],
        at,
        0.2,
        this.menuBus,
        0.055,
        0.7,
        "triangle",
      );
      this.fmNote(
        actionLead[(position / 2) % actionLead.length],
        at,
        0.14,
        this.actionBus,
        0.075,
        modulation,
      );
      this.fmNote(
        actionBass[(position / 2) % actionBass.length],
        at,
        0.2,
        this.actionBus,
        0.065,
        0.55,
        "triangle",
      );
    }
    if (position === 4 || position === 12)
      this.fmNote(
        783.99,
        at,
        0.08,
        this.actionBus,
        0.025,
        modulation,
        "triangle",
      );
    this.step += 1;
  }

  private startScheduler() {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      const context = this.context;
      if (!context) return;
      while (this.nextStepAt < context.currentTime + 0.12) {
        this.scheduleStep(this.nextStepAt);
        const bpm = 102 + this.intensity * 82;
        this.nextStepAt += 60 / bpm / 4;
      }
    }, 25);
  }

  transition(theme: Theme) {
    const context = this.ensureContext();
    if (!context || !this.menuBus || !this.actionBus) return;
    const at = context.currentTime;
    this.menuBus.gain.cancelScheduledValues(at);
    this.actionBus.gain.cancelScheduledValues(at);
    this.menuBus.gain.setTargetAtTime(theme === "menu" ? 1 : 0.0001, at, 0.22);
    this.actionBus.gain.setTargetAtTime(
      theme === "action" ? 1 : 0.0001,
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
    if (this.master && this.context)
      this.master.gain.setTargetAtTime(
        muted ? 0 : 0.7,
        this.context.currentTime,
        0.04,
      );
  }

  play(effect: DeliverySfx) {
    const context = this.ensureContext();
    if (!context || !this.master || this.muted) return;
    const at = context.currentTime;
    if (effect === "throw") {
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
      envelope.connect(this.master);
      oscillator.start(at);
      oscillator.stop(at + 0.15);
    } else if (effect === "delivery") {
      [523.25, 659.25, 783.99, 1046.5].forEach((note, index) =>
        this.fmNote(note, at + index * 0.055, 0.16, this.master!, 0.12, 1.15),
      );
    } else if (effect === "crash") {
      this.noise(at, 0.38, 0.38);
      this.fmNote(95, at, 0.35, this.master, 0.2, 2.4, "sawtooth");
    } else if (effect === "yelp") {
      this.fmNote(430, at, 0.1, this.master, 0.16, 1.6, "sawtooth");
      this.fmNote(780, at + 0.07, 0.18, this.master, 0.18, 2, "triangle");
    } else if (effect === "bark") {
      this.noise(at, 0.08, 0.2);
      this.fmNote(185, at, 0.09, this.master, 0.19, 2.2, "sawtooth");
      this.noise(at + 0.12, 0.07, 0.17);
      this.fmNote(155, at + 0.12, 0.1, this.master, 0.17, 2, "sawtooth");
    } else if (effect === "meow") {
      this.fmNote(620, at, 0.15, this.master, 0.16, 1.8, "triangle");
      this.fmNote(870, at + 0.1, 0.2, this.master, 0.13, 2.4, "sine");
    } else if (effect === "moo") {
      this.fmNote(105, at, 0.42, this.master, 0.22, 3.2, "sawtooth");
      this.fmNote(82, at + 0.24, 0.5, this.master, 0.2, 2.6, "triangle");
    } else if (effect === "squish") {
      this.noise(at, 0.09, 0.28);
      this.fmNote(240, at, 0.08, this.master, 0.2, 3.4, "square");
      this.fmNote(72, at + 0.055, 0.2, this.master, 0.24, 1.7, "sawtooth");
    } else if (effect === "ouch") {
      const voice = new SpeechSynthesisUtterance("Ouch!");
      voice.rate = 1.35;
      voice.pitch = 1.1;
      voice.volume = 0.8;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(voice);
    } else {
      [261.63, 329.63, 392, 523.25, 659.25, 783.99, 1046.5].forEach(
        (note, index) =>
          this.fmNote(
            note,
            at + index * 0.09,
            0.32,
            this.master!,
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
    this.motor = null;
    this.motorGain = null;
    this.step = 0;
  }
}

export const deliveryAudio = new DeliveryAudioManager();
