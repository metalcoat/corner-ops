class ArcadeAudioEngine {
  private ctx: AudioContext | null = null;
  private bgmInterval: NodeJS.Timeout | null = null;
  private isMuted: boolean = false;

  private initContext() {
    if (!this.ctx && typeof window !== "undefined") {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  public triggerHaptic(type: "light" | "medium" | "heavy" | "error" = "light") {
    if (typeof window === "undefined") return;

    const capacitor = (
      window as unknown as {
        Capacitor?: {
          isNativePlatform: () => boolean;
          Plugins?: { Haptics?: { impact: (opts: { style: string }) => void } };
        };
      }
    ).Capacitor;

    if (capacitor?.isNativePlatform() && capacitor.Plugins?.Haptics) {
      const styleMap: Record<string, string> = {
        light: "LIGHT",
        medium: "MEDIUM",
        heavy: "HEAVY",
        error: "HEAVY",
      };
      capacitor.Plugins.Haptics.impact({ style: styleMap[type] || "LIGHT" });
      return;
    }

    if ("vibrate" in navigator) {
      if (type === "light") navigator.vibrate(15);
      else if (type === "medium") navigator.vibrate(35);
      else if (type === "heavy") navigator.vibrate(75);
      else if (type === "error") navigator.vibrate([60, 40, 60]);
    }
  }

  public playSound(name: "steer" | "pizza" | "battery" | "crash" | "start") {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);

    if (name === "steer") {
      osc.type = "square";
      osc.frequency.setValueAtTime(220, t);
      osc.frequency.exponentialRampToValueAtTime(440, t + 0.05);
      gain.gain.setValueAtTime(0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.01, t + 0.05);
      osc.start(t);
      osc.stop(t + 0.05);
      this.triggerHaptic("light");
    } else if (name === "pizza") {
      osc.type = "square";
      osc.frequency.setValueAtTime(987.77, t);
      osc.frequency.setValueAtTime(1318.51, t + 0.08);
      gain.gain.setValueAtTime(0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.01, t + 0.25);
      osc.start(t);
      osc.stop(t + 0.25);
      this.triggerHaptic("medium");
    } else if (name === "battery") {
      osc.type = "triangle";
      osc.frequency.setValueAtTime(330, t);
      osc.frequency.exponentialRampToValueAtTime(880, t + 0.18);
      gain.gain.setValueAtTime(0.15, t);
      gain.gain.exponentialRampToValueAtTime(0.01, t + 0.2);
      osc.start(t);
      osc.stop(t + 0.2);
      this.triggerHaptic("medium");
    } else if (name === "crash") {
      const bufferSize = this.ctx.sampleRate * 0.35;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseGain = this.ctx.createGain();
      noiseGain.gain.setValueAtTime(0.3, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.01, t + 0.35);
      noise.connect(noiseGain);
      noiseGain.connect(this.ctx.destination);
      noise.start(t);
      this.triggerHaptic("error");
    } else if (name === "start") {
      osc.type = "square";
      osc.frequency.setValueAtTime(440, t);
      osc.frequency.setValueAtTime(554.37, t + 0.08);
      osc.frequency.setValueAtTime(659.25, t + 0.16);
      osc.frequency.setValueAtTime(880, t + 0.24);
      gain.gain.setValueAtTime(0.1, t);
      gain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);
      osc.start(t);
      osc.stop(t + 0.4);
    }
  }

  public startBGM() {
    if (this.isMuted || this.bgmInterval) return;
    this.initContext();
    if (!this.ctx) return;

    const melody = [110, 110, 130.81, 146.83, 110, 164.81, 146.83, 130.81];
    let noteIndex = 0;

    this.bgmInterval = setInterval(() => {
      if (!this.ctx || this.isMuted) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = "triangle";
      osc.frequency.setValueAtTime(melody[noteIndex], t);
      gain.gain.setValueAtTime(0.06, t);
      gain.gain.exponentialRampToValueAtTime(0.005, t + 0.12);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(t);
      osc.stop(t + 0.14);

      noteIndex = (noteIndex + 1) % melody.length;
    }, 140);
  }

  public stopBGM() {
    if (this.bgmInterval) {
      clearInterval(this.bgmInterval);
      this.bgmInterval = null;
    }
  }

  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    if (this.isMuted) {
      this.stopBGM();
    }
    return this.isMuted;
  }
}

export const arcadeAudio = new ArcadeAudioEngine();
