"use client";
import { useEffect, useState } from "react";

type Settings = { active: boolean; onlineRate: number; storeRate: number; staffPhoneOrdersEarn: boolean; bonusMultiplier: number; bonusDays: number[]; bonusStart: string; bonusEnd: string; expiryMonths: number };
type Reward = { id: string; label: string; points: number; kind: string; active: boolean };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function PointsSettingsClient() {
  const [settings, setSettings] = useState<Settings | null>(null),
    [rewards, setRewards] = useState<Reward[]>([]),
    [message, setMessage] = useState("");
  async function load(response?: Response) {
    const result = response || (await fetch("/api/ordering/settings/points"));
    const body = await result.json();
    if (!result.ok) return setMessage(body.error || "Points settings could not be loaded.");
    setSettings(body.settings);
    setRewards(body.rewards);
  }
  useEffect(() => { void load(); }, []);
  async function save() {
    setMessage("");
    const response = await fetch("/api/ordering/settings/points", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings, rewards }) });
    if (!response.ok) return setMessage((await response.json()).error || "Could not save.");
    await load(response);
    setMessage("Saved.");
  }
  if (!settings) return <section className="promotionSettings"><h2>Reward points</h2><p>{message || "Loading…"}</p></section>;
  const set = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch });
  return (
    <section className="promotionSettings">
      <h2>Reward points</h2>
      <p>Customers earn points on every order and spend them on the rewards below. Staff-taken orders need the code texted to the customer before points are used.</p>
      <div className="promotionForm">
        <label><input type="checkbox" checked={settings.active} onChange={(event) => set({ active: event.target.checked })} /> Points program on</label>
        <label>Online points per $1<input type="number" step="0.1" min="0" value={settings.onlineRate} onChange={(event) => set({ onlineRate: Number(event.target.value) })} /></label>
        <label>In-store and phone points per $1<input type="number" step="0.1" min="0" value={settings.storeRate} onChange={(event) => set({ storeRate: Number(event.target.value) })} /></label>
        <label><input type="checkbox" checked={settings.staffPhoneOrdersEarn} onChange={(event) => set({ staffPhoneOrdersEarn: event.target.checked })} /> Phone orders taken by staff earn points (after they're paid)</label>
        <label>Bonus multiplier<input type="number" step="0.5" min="1" value={settings.bonusMultiplier} onChange={(event) => set({ bonusMultiplier: Number(event.target.value) })} /></label>
        <fieldset><legend>Bonus days</legend>{DAYS.map((day, index) => (
          <label key={day}><input type="checkbox" checked={settings.bonusDays.includes(index)} onChange={(event) => set({ bonusDays: event.target.checked ? [...settings.bonusDays, index] : settings.bonusDays.filter((value) => value !== index) })} /> {day}</label>
        ))}</fieldset>
        <label>Bonus from<input type="time" value={settings.bonusStart} onChange={(event) => set({ bonusStart: event.target.value })} /></label>
        <label>Bonus until<input type="time" value={settings.bonusEnd} onChange={(event) => set({ bonusEnd: event.target.value })} /></label>
        <label>Points expire after this many months with no orders (0 = never)<input type="number" min="0" value={settings.expiryMonths} onChange={(event) => set({ expiryMonths: Number(event.target.value) })} /></label>
      </div>
      <div className="promotionForm">
        <h3>Rewards</h3>
        {rewards.map((reward) => (
          <label key={reward.id}>
            <input type="checkbox" checked={reward.active} onChange={(event) => setRewards(rewards.map((row) => (row.id === reward.id ? { ...row, active: event.target.checked } : row)))} /> {reward.label}
            <input type="number" min="1" value={reward.points} onChange={(event) => setRewards(rewards.map((row) => (row.id === reward.id ? { ...row, points: Number(event.target.value) } : row)))} /> points
          </label>
        ))}
      </div>
      <button type="button" onClick={() => void save()}>Save points settings</button>
      {message && <p>{message}</p>}
    </section>
  );
}
