"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ALERT_SOUNDS, renderAlertSound } from "@/lib/alert-sounds";
import { greeterNext } from "@/lib/door-chime-policy";

const POLL_MS = 2_000;
/** No good answer from the server for this long: say so loudly, walk-ins won't sound. */
const STALE_MS = 15_000;
const SETTINGS_KEY = "corner-ops-door-alarm";

type Settings = { sound: string; volume: number; repeat: number };
const DEFAULTS: Settings = { sound: "warm_chime", volume: 100, repeat: 2 };

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") as Partial<Settings> | null;
    return { ...DEFAULTS, ...(saved || {}) };
  } catch {
    return DEFAULTS;
  }
}

const clock = (date: Date) => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

export default function DoorAlarm() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [soundOn, setSoundOn] = useState(false);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [walkIns, setWalkIns] = useState<Date[]>([]);
  const [flash, setFlash] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const buffers = useRef(new Map<string, AudioBuffer>());
  const current = useRef(settings);
  const state = useRef({ initialized: false, lastId: 0 });

  useEffect(() => {
    const saved = loadSettings();
    setSettings(saved);
    current.current = saved;
  }, []);

  const save = (next: Settings) => {
    setSettings(next);
    current.current = next;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Settings just won't be remembered on this computer.
    }
  };

  const unlock = useCallback(async () => {
    const Context = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    audio.current ??= new Context();
    if (audio.current.state !== "running") await audio.current.resume().catch(() => undefined);
    setSoundOn(audio.current.state === "running");
  }, []);

  const ring = useCallback(() => {
    const context = audio.current;
    if (!context || context.state !== "running") return false;
    const { sound, volume, repeat } = current.current;
    const key = `${sound}@${context.sampleRate}`;
    let buffer = buffers.current.get(key);
    if (!buffer) {
      const { left, right } = renderAlertSound(sound, context.sampleRate);
      buffer = context.createBuffer(2, left.length, context.sampleRate);
      buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
      buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
      buffers.current.set(key, buffer);
    }
    const gain = context.createGain();
    gain.gain.value = Math.max(0.05, Math.min(1, volume / 100));
    gain.connect(context.destination);
    for (let n = 0; n < Math.max(1, repeat); n++) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(context.currentTime + n * (buffer.duration * 0.8));
    }
    return true;
  }, []);

  useEffect(() => {
    // Started with --autoplay-policy=no-user-gesture-required this needs no click; otherwise the button below.
    void unlock();
    const tap = () => void unlock();
    window.addEventListener("pointerdown", tap);
    window.addEventListener("keydown", tap);
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch("/api/pos/greeter", { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const { latest } = (await response.json()) as { latest: { id: number; ageSeconds: number } | null };
        setLastOk(Date.now());
        if (greeterNext(state.current, latest) === null || !latest) return;
        const at = new Date(Date.now() - latest.ageSeconds * 1000);
        setWalkIns((list) => [at, ...list].slice(0, 12));
        setFlash(true);
        window.setTimeout(() => setFlash(false), 6_000);
        if (!ring()) void unlock().then(ring);
      } catch {
        // The banner turns red once answers stop for STALE_MS.
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(tick);
      window.removeEventListener("pointerdown", tap);
      window.removeEventListener("keydown", tap);
    };
  }, [ring, unlock]);

  const connected = lastOk !== null && now - lastOk < STALE_MS;
  useEffect(() => {
    document.title = !connected ? "⚠ NOT CONNECTED · Door alarm" : walkIns[0] ? `Walk-in ${clock(walkIns[0])} · Door alarm` : "Door alarm | Corner Deli";
  }, [connected, walkIns]);

  return (
    <main className={`doorAlarm ${flash ? "doorAlarmFlash" : ""}`}>
      {!connected ? (
        <div className="doorAlarmBanner bad" role="alert">NOT CONNECTED TO THE STORE SERVER — walk-ins will not sound. Check this computer&apos;s network.</div>
      ) : !soundOn ? (
        <button type="button" className="doorAlarmBanner warn" onClick={() => void unlock()}>SOUND IS OFF — CLICK ANYWHERE TO TURN IT ON</button>
      ) : (
        <div className="doorAlarmBanner ok" role="status">Listening for walk-ins · sound on</div>
      )}
      <section className="doorAlarmMain">
        <p className="doorAlarmLabel">{flash ? "CUSTOMER WALKED IN" : "Last walk-in"}</p>
        <strong className="doorAlarmTime">{walkIns[0] ? clock(walkIns[0]) : "—"}</strong>
        {walkIns.length > 1 && <p className="doorAlarmEarlier">Earlier: {walkIns.slice(1, 8).map(clock).join(" · ")}</p>}
      </section>
      <section className="doorAlarmSettings" aria-label="Sound settings">
        <label>
          Sound
          <select value={settings.sound} onChange={(event) => save({ ...settings, sound: event.target.value })}>
            {ALERT_SOUNDS.map((sound) => <option key={sound.id} value={sound.id}>{sound.label}</option>)}
          </select>
        </label>
        <label>
          Volume {settings.volume}%
          <input type="range" min={10} max={100} step={5} value={settings.volume} onChange={(event) => save({ ...settings, volume: Number(event.target.value) })} />
        </label>
        <label>
          Times
          <select value={settings.repeat} onChange={(event) => save({ ...settings, repeat: Number(event.target.value) })}>
            {[1, 2, 3].map((count) => <option key={count} value={count}>{count}×</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void unlock().then(ring)}>TEST SOUND</button>
      </section>
      <small className="doorAlarmNote">Keep this page open. Computer speakers must be on and not muted. Only works on the store network.</small>
    </main>
  );
}
