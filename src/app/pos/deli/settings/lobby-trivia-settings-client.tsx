"use client";

import { useEffect, useState } from "react";

type Player = { id: number; name: string; hidden: boolean; linked: boolean; today: number; month: number; lastSeen: string };
type Settings = { enabled: boolean; players: Player[] };

/** Lobby trivia on the greeter TV: the on/off switch, and hiding a player's name from every board. */
export default function LobbyTriviaSettingsClient() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/ordering/settings/trivia", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load the trivia settings.");
        setSettings(payload);
      })
      .catch((error: Error) => setMessage(error.message));
  }, []);

  async function save(change: { enabled?: boolean; playerId?: number; hidden?: boolean }, done: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/ordering/settings/trivia", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not save.");
      setSettings(payload);
      setMessage(done);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="posSettingsCard">
    <p className="posDevEyebrow">Front door TV</p>
    <h2>Lobby trivia</h2>
    {settings ? <>
      <label><span>Show trivia on the greeter TV</span><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={(event) => void save({ enabled: event.target.checked }, event.target.checked ? "Trivia is on. The QR shows on the greeter TV within a few seconds." : "Trivia is off. The QR leaves the TV and phones can't play.")} /></label>
      <p className="posSettingsHint">Customers scan the TV&apos;s trivia code (it changes every minute), pick a nickname and answer up to 15 questions a day. No prizes or points. Off hides the code and boards, and phones see &quot;Trivia is paused.&quot;</p>
      {settings.players.length > 0 && <>
        <h3>Players</h3>
        <p className="posSettingsHint">Hide a name you don&apos;t want on the TV or the leaderboards. They can still play.</p>
        <table>
          <thead><tr><th>Name</th><th>Right today</th><th>This month</th><th>Last played</th><th /></tr></thead>
          <tbody>
            {settings.players.map((player) => <tr key={player.id}>
              <td>{player.hidden ? <s>{player.name}</s> : player.name}{player.linked ? " · phone added" : ""}</td>
              <td>{player.today}</td>
              <td>{player.month}</td>
              <td>{player.lastSeen}</td>
              <td><button type="button" disabled={busy} onClick={() => void save({ playerId: player.id, hidden: !player.hidden }, player.hidden ? `${player.name} is back on the boards.` : `${player.name} is hidden from the boards.`)}>{player.hidden ? "Show" : "Hide"}</button></td>
            </tr>)}
          </tbody>
        </table>
      </>}
    </> : null}
    {message && <p role="status">{message}</p>}
  </section>;
}
