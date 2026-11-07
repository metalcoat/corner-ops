"use client";

import { useEffect, useState } from "react";

const KEY = "corner-ops-home-default";

/**
 * Per device: the registers can open straight to the POS while a manager's tablet shows this home
 * screen. /pos?choose=1 (the POS's Apps button) always shows the home screen.
 */
export default function PosHomeDefault({ choices }: { choices: Array<{ href: string; title: string }> }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    let saved = "";
    try { saved = localStorage.getItem(KEY) || ""; } catch {}
    const choosing = new URLSearchParams(window.location.search).has("choose");
    if (saved && !choosing && choices.some((choice) => choice.href === saved)) { window.location.replace(saved); return; }
    setValue(saved);
  }, [choices]);
  function change(next: string) {
    setValue(next);
    try { if (next) localStorage.setItem(KEY, next); else localStorage.removeItem(KEY); } catch {}
  }
  return (
    <footer className="posHomeDefault">
      <label htmlFor="home-default">On this device, open</label>
      <select id="home-default" value={value} onChange={(event) => change(event.target.value)}>
        <option value="">this home screen</option>
        {choices.map((choice) => <option key={choice.href} value={choice.href}>{choice.title} straight away</option>)}
      </select>
      <small>{value ? "Use the Apps button (▦) in the POS to get back here." : "Registers can be set to open the POS straight away."}</small>
    </footer>
  );
}
