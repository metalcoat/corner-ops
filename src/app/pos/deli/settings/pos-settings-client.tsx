"use client";

import { useEffect, useState } from "react";
import type { OnlineOrderAlertSound } from "@/lib/ordering-pos-settings";

type Settings = {
  posIdleLockSeconds: number;
  onlineOrderAlertSound: OnlineOrderAlertSound;
  onlineOrderAlertVolume: number;
  businessTimezone: string;
};
const sounds: { value: OnlineOrderAlertSound; label: string }[] = [
  { value: "kitchen_ring", label: "Loud kitchen ring" },
  { value: "horn", label: "Horn" },
  { value: "air_horn", label: "Air horn / honk" },
  { value: "cha_ching", label: "Cash register cha-ching" },
  { value: "buzzer", label: "Kitchen buzzer" },
  { value: "telephone", label: "Telephone ring" },
  { value: "soft_chime", label: "Soft chime" },
  { value: "off", label: "Off" },
];

export default function PosSettingsClient() {
  const [settings, setSettings] = useState<Settings | null>(null),
    [value, setValue] = useState(60),
    [sound, setSound] = useState<OnlineOrderAlertSound>("kitchen_ring"),
    [volume, setVolume] = useState(100),
    [confirm, setConfirm] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    fetch("/api/ordering/settings/pos")
      .then((r) => r.json())
      .then((b) => {
        if (b.settings) {
          setSettings(b.settings);
          setValue(b.settings.posIdleLockSeconds);
          setSound(b.settings.onlineOrderAlertSound);
          setVolume(b.settings.onlineOrderAlertVolume);
        }
      });
  }, []);
  function preview() {
    window.dispatchEvent(
      new CustomEvent("corner-ops-online-order-alert-preference", {
        detail: { sound, volume, test: true },
      }),
    );
  }
  async function save() {
    const r = await fetch("/api/ordering/settings/pos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        posIdleLockSeconds: value,
        confirmDisabled: confirm,
        onlineOrderAlertSound: sound,
        onlineOrderAlertVolume: volume,
      }),
    });
    const b = await r.json();
    setMessage(
      r.ok
        ? "POS security and alert settings saved."
        : b.error || "Could not save settings.",
    );
    if (r.ok) {
      setSettings(b.settings);
      window.dispatchEvent(
        new CustomEvent("corner-ops-online-order-alert-preference", {
          detail: { sound, volume },
        }),
      );
    }
  }
  return (
    <>
      <section className="posSettingsCard">
        <h2>Online order alert</h2>
        <label>
          <span>ALERT SOUND</span>
          <select
            value={sound}
            onChange={(e) => setSound(e.target.value as OnlineOrderAlertSound)}
          >
            {sounds.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>VOLUME · {volume}%</span>
          <input
            type="range"
            min="10"
            max="100"
            step="5"
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        </label>
        <div className="posTools">
          <button type="button" disabled={sound === "off"} onClick={preview}>
            TEST SOUND
          </button>
        </div>
        <p className="posSettingsHint">
          Plays once when a new online, kiosk, or AI phone order reaches every
          open POS and KDS. Device volume still controls maximum loudness.
        </p>
      </section>
      <section className="posSettingsCard">
        <h2>POS security</h2>
        <label>
          <span>AUTO LOCK AFTER</span>
          <div>
            <input
              type="number"
              min={value === 0 ? 0 : 15}
              max="3600"
              value={value}
              onChange={(e) => {
                setValue(Number(e.target.value));
                setConfirm(false);
              }}
            />{" "}
            seconds
          </div>
        </label>
        <div className="posTools">
          {[30, 60, 120, 300, 600].map((s) => (
            <button
              key={s}
              onClick={() => {
                setValue(s);
                setConfirm(false);
              }}
            >
              {s < 60 ? `${s} sec` : `${s / 60} min`}
            </button>
          ))}
          <button onClick={() => setValue(0)}>Disabled</button>
        </div>
        {value === 0 && (
          <div className="posSettingsWarning">
            <strong>Automatic locking will be disabled.</strong>
            <p>
              The Lock button still works. This increases the risk of another
              employee using an unlocked identity.
            </p>
            <label>
              <input
                type="checkbox"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />{" "}
              I deliberately want to disable automatic locking.
            </label>
          </div>
        )}
        <p className="posSettingsHint">
          Valid: disabled (0) or 15–3600 seconds. Current saved value:{" "}
          {settings?.posIdleLockSeconds ?? "…"}. Human activity resets the
          timer; background requests do not.
        </p>
        <button disabled={value === 0 && !confirm} onClick={() => void save()}>
          SAVE POS SETTINGS
        </button>
        {message && <p role="status">{message}</p>}
      </section>
    </>
  );
}
