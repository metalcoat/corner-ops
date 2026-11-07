/** Generation and playback finish independently. A caller interruption invalidates recovery. */
export class PhoneSpeechState {
  generating = false;
  playing = false;
  interrupted = false;
  private recovery: (() => void) | undefined;
  get busy() {
    return this.generating || this.playing;
  }
  start() {
    this.generating = true;
    this.interrupted = false;
    this.recovery = undefined;
  }
  audio() {
    if (!this.interrupted) this.playing = true;
  }
  done() {
    this.generating = false;
    this.flush();
  }
  drained() {
    this.playing = false;
    this.flush();
  }
  interrupt() {
    this.interrupted = true;
    this.recovery = undefined;
  }
  recover(callback: () => void) {
    if (!this.interrupted) {
      this.recovery = callback;
      this.flush();
    }
  }
  private flush() {
    if (this.busy || this.interrupted || !this.recovery) return;
    const callback = this.recovery;
    this.recovery = undefined;
    callback();
  }
}

export function needsSpeechRecovery(
  status: string,
  unfinished: boolean,
  interrupted: boolean,
) {
  return (
    !interrupted &&
    status !== "cancelled" &&
    (status === "incomplete" || status === "failed" || unfinished)
  );
}
