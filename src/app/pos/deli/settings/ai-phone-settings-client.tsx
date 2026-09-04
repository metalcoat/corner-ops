"use client";

import { useEffect, useState } from "react";

type Settings = {
  enabled: boolean;
  mode: "shadow" | "assisted" | "autonomous";
  provider: "openai" | "gemini";
  model: string;
  openaiModel: string;
  geminiModel: string;
  maxResponseWords: number;
  maxUpsells: number;
  vadEagerness: "low" | "medium" | "high";
  recordingEnabled: boolean;
  transcriptRetentionDays: number;
};
type ProviderReadiness = {
  ready: boolean;
  configured?: boolean;
  liveBridgeReady?: boolean;
};
type Payload = {
  settings: Settings;
  businessState: {
    pickupWait: string;
    deliveryWait: string;
    pickupAvailable: boolean;
    deliveryAvailable: boolean;
  };
  readiness: {
    ready: boolean;
    providers: { openai: ProviderReadiness; gemini: ProviderReadiness };
  };
};

export default function AiPhoneSettingsClient() {
  const [data, setData] = useState<Payload | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/api/ordering/settings/ai-phone", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as Payload;
        if (active && response.ok) {
          setData(body);
          setDraft(body.settings);
        }
      })
      .catch(() => {
        if (active) setMessage("AI phone settings are unavailable.");
      });
    return () => {
      active = false;
    };
  }, []);
  async function save() {
    if (!draft) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/ordering/settings/ai-phone", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Could not save settings.");
      setDraft(body.settings);
      setData((current) =>
        current ? { ...current, settings: body.settings } : current,
      );
      setMessage("AI phone settings saved.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not save settings.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function testGemini() {
    if (!draft) return;
    setBusy(true);
    setMessage("Testing Gemini…");
    try {
      const response = await fetch("/api/ordering/settings/ai-phone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "test-gemini",
          model: draft.geminiModel,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Gemini connection failed.");
      setMessage(`Gemini ${body.result.model} connection verified.`);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Gemini connection failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!draft)
    return (
      <section className="posSettingsCard">
        <h2>AI phone ordering</h2>
        <p role={message ? "alert" : undefined}>{message || "Loading…"}</p>
      </section>
    );
  const gemini = data?.readiness.providers.gemini;
  return (
    <section className="posSettingsCard">
      <h2>AI phone ordering</h2>
      <p>
        <strong>{data?.readiness.ready ? "READY" : "NOT READY"}</strong> ·
        Pickup:{" "}
        {data?.businessState.pickupAvailable
          ? data.businessState.pickupWait
          : "unavailable"}{" "}
        · Delivery:{" "}
        {data?.businessState.deliveryAvailable
          ? data.businessState.deliveryWait
          : "unavailable"}
      </p>
      <label>
        <span>Answer calls</span>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) =>
            setDraft({ ...draft, enabled: event.target.checked })
          }
        />
      </label>
      <label>
        <span>Voice provider</span>
        <select
          value={draft.provider}
          onChange={(event) =>
            setDraft({
              ...draft,
              provider: event.target.value as Settings["provider"],
            })
          }
        >
          <option value="openai">OpenAI</option>
          <option value="gemini" disabled={!gemini?.liveBridgeReady}>
            Google Gemini
            {gemini?.liveBridgeReady ? "" : " — bridge pending"}
          </option>
        </select>
      </label>
      <label>
        <span>OpenAI realtime model</span>
        <input
          value={draft.openaiModel}
          onChange={(event) =>
            setDraft({ ...draft, openaiModel: event.target.value })
          }
        />
      </label>
      <label>
        <span>Gemini Live model</span>
        <input
          value={draft.geminiModel}
          onChange={(event) =>
            setDraft({ ...draft, geminiModel: event.target.value })
          }
        />
      </label>
      <p>
        <strong>Gemini API:</strong>{" "}
        {gemini?.configured ? "key configured" : "key missing"} · Live phone
        bridge: {gemini?.liveBridgeReady ? "ready" : "being configured"}
      </p>
      <button
        type="button"
        disabled={busy || !gemini?.configured}
        onClick={() => void testGemini()}
      >
        {busy ? "TESTING…" : "TEST GEMINI CONNECTION"}
      </button>
      <label>
        <span>Operating mode</span>
        <select
          value={draft.mode}
          onChange={(event) =>
            setDraft({ ...draft, mode: event.target.value as Settings["mode"] })
          }
        >
          <option value="shadow">Shadow — never submit</option>
          <option value="assisted">Assisted — staff review</option>
          <option value="autonomous">
            Autonomous — submit after confirmation
          </option>
        </select>
      </label>
      <label>
        <span>Maximum response words</span>
        <input
          type="number"
          min="2"
          max="30"
          value={draft.maxResponseWords}
          onChange={(event) =>
            setDraft({ ...draft, maxResponseWords: Number(event.target.value) })
          }
        />
      </label>
      <label>
        <span>Maximum upsells per order</span>
        <input
          type="number"
          min="0"
          max="3"
          value={draft.maxUpsells}
          onChange={(event) =>
            setDraft({ ...draft, maxUpsells: Number(event.target.value) })
          }
        />
      </label>
      <label>
        <span>Turn detection</span>
        <select
          value={draft.vadEagerness}
          onChange={(event) =>
            setDraft({
              ...draft,
              vadEagerness: event.target.value as Settings["vadEagerness"],
            })
          }
        >
          <option value="high">Fast</option>
          <option value="medium">Balanced</option>
          <option value="low">Patient</option>
        </select>
      </label>
      <label>
        <span>Transcript retention days</span>
        <input
          type="number"
          min="1"
          max="365"
          value={draft.transcriptRetentionDays}
          onChange={(event) =>
            setDraft({
              ...draft,
              transcriptRetentionDays: Number(event.target.value),
            })
          }
        />
      </label>
      <label>
        <span>Call recording</span>
        <input
          type="checkbox"
          checked={draft.recordingEnabled}
          onChange={(event) =>
            setDraft({ ...draft, recordingEnabled: event.target.checked })
          }
        />
      </label>
      <p>
        <strong>Safety:</strong> recording remains off by default. Shadow mode
        is required when evaluating a newly selected provider.
      </p>
      <button disabled={busy} onClick={() => void save()}>
        {busy ? "SAVING…" : "SAVE AI PHONE SETTINGS"}
      </button>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
