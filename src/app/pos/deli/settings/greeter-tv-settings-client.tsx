"use client";

import { useEffect, useRef, useState } from "react";

type Volumes = { music: number; greeting: number };

/** Greeter TV volumes. The TV picks up a change within a few seconds. */
export default function GreeterTvSettingsClient() {
  const [volumes, setVolumes] = useState<Volumes | null>(null);
  const [message, setMessage] = useState("");
  const save = useRef<number | undefined>(undefined);

  useEffect(() => {
    void fetch("/api/ordering/settings/greeter", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load the greeter TV volumes.");
        setVolumes(payload);
      })
      .catch((error: Error) => setMessage(error.message));
  }, []);

  function change(next: Volumes) {
    setVolumes(next);
    setMessage("");
    window.clearTimeout(save.current);
    save.current = window.setTimeout(async () => {
      const response = await fetch("/api/ordering/settings/greeter", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      const payload = await response.json().catch(() => ({}));
      setMessage(response.ok ? "Saved. The greeter TV changes within a few seconds." : payload.error || "Could not save the volume.");
    }, 400);
  }

  return <section className="posSettingsCard">
    <p className="posDevEyebrow">Front door TV</p>
    <h2>Greeter TV volume</h2>
    {volumes ? <>
      <label><span>Music: {volumes.music}%</span><input type="range" min={0} max={100} step={1} value={volumes.music} onChange={(event) => change({ ...volumes, music: Number(event.target.value) })} /></label>
      <label><span>Welcome greeting: {volumes.greeting}%</span><input type="range" min={0} max={100} step={1} value={volumes.greeting} onChange={(event) => change({ ...volumes, greeting: Number(event.target.value) })} /></label>
      <p className="posSettingsHint">Music plays between greetings; it pauses while a walk-in is welcomed. The TV&apos;s own volume still sets the overall level.</p>
    </> : null}
    {message && <p role="status">{message}</p>}
  </section>;
}
