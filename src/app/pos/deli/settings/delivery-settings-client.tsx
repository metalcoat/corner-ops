"use client";

import { useEffect, useState } from "react";
import "../../pos-separation.css";

type FeeBand = {
  minMilesExclusive: number;
  maxMilesInclusive: number;
  feeCents: number;
};

type Settings = {
  business: "Corner Deli";
  enabled: boolean;
  minimumOrderCents: number;
  deliveryFeeCountsTowardMinimum: boolean;
  offerUpsellBeforeShortfallFee: boolean;
  allowShortfallFee: boolean;
  shortfallFeeLabel: string;
  allowManagerBypass: boolean;
  notifyManagementOnBypass: boolean;
  maxDistanceMiles: number | null;
  pricesIncludeTax: boolean;
  taxRateBps: number;
  taxRateConfigured: boolean;
  deliveryFeeTaxable: boolean;
  minimumAdjustmentTaxable: boolean;
  feeBands: FeeBand[];
};

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function cents(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

export default function DeliverySettingsClient() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/ordering/settings/delivery?business=Corner%20Deli", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { settings?: Settings; error?: string };
        if (!response.ok || !payload.settings) throw new Error(payload.error || "Could not load delivery settings.");
        setSettings(payload.settings);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load delivery settings."))
      .finally(() => setLoading(false));
  }, []);

  function updateBand(index: number, patch: Partial<FeeBand>) {
    setSettings((current) => current ? {
      ...current,
      feeBands: current.feeBands.map((band, bandIndex) => bandIndex === index ? { ...band, ...patch } : band),
    } : current);
  }

  function addBand() {
    setSettings((current) => {
      if (!current) return current;
      const previous = current.feeBands[current.feeBands.length - 1];
      const min = previous?.maxMilesInclusive ?? 0;
      const max = min + 2;
      return {
        ...current,
        maxDistanceMiles: max,
        feeBands: [...current.feeBands, { minMilesExclusive: min, maxMilesInclusive: max, feeCents: previous?.feeCents ?? 0 }],
      };
    });
  }

  function removeBand(index: number) {
    setSettings((current) => {
      if (!current || current.feeBands.length <= 1) return current;
      const next = current.feeBands.filter((_, bandIndex) => bandIndex !== index);
      return { ...current, feeBands: next, maxDistanceMiles: next[next.length - 1]?.maxMilesInclusive ?? null };
    });
  }

  async function save() {
    if (!settings || saving) return;
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/ordering/settings/delivery", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json() as { settings?: Settings; error?: string };
      if (!response.ok || !payload.settings) throw new Error(payload.error || "Could not save delivery settings.");
      setSettings(payload.settings);
      setMessage("Delivery and tax settings saved for the development POS.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save delivery settings.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <main className="posReportPage">Loading delivery settings…</main>;
  if (!settings) return <main className="posReportPage"><p>{error || "Delivery settings are unavailable."}</p><a href="/pos/deli">Back to Corner Deli POS</a></main>;

  return <main className="posReportPage">
    <header className="posReportHeader">
      <div>
        <span className="posDevBadge">DEVELOPMENT · DELI ONLY</span>
        <p className="posDevEyebrow">Corner Deli delivery configuration</p>
        <h1>Delivery, minimums, and tax</h1>
        <p>These values are shared by the Deli POS, employee-entered phone orders, AI ordering, and future web ordering. Tax is extracted from inclusive prices instead of being added twice, because accounting has suffered enough.</p>
      </div>
      <a href="/pos/deli">Back to Deli POS</a>
    </header>

    <section className="posSettingsGrid">
      <article className="posSettingsCard">
        <h2>Delivery policy</h2>
        <label><span>Delivery enabled</span><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /></label>
        <label><span>Minimum delivery total</span><div className="posMoneyInput"><b>$</b><input type="number" min="0" step="0.01" value={dollars(settings.minimumOrderCents)} onChange={(event) => setSettings({ ...settings, minimumOrderCents: cents(event.target.value) })} /></div></label>
        <label><span>Delivery fee counts toward minimum</span><input type="checkbox" checked={settings.deliveryFeeCountsTowardMinimum} onChange={(event) => setSettings({ ...settings, deliveryFeeCountsTowardMinimum: event.target.checked })} /></label>
        <label><span>Maximum delivery miles</span><input type="number" min="0.1" step="0.1" value={settings.maxDistanceMiles ?? ""} onChange={(event) => setSettings({ ...settings, maxDistanceMiles: Number(event.target.value) })} /></label>
        <label><span>Offer add-ons before round-up</span><input type="checkbox" checked={settings.offerUpsellBeforeShortfallFee} onChange={(event) => setSettings({ ...settings, offerUpsellBeforeShortfallFee: event.target.checked })} /></label>
        <label><span>Allow round-up to minimum</span><input type="checkbox" checked={settings.allowShortfallFee} onChange={(event) => setSettings({ ...settings, allowShortfallFee: event.target.checked })} /></label>
        <label><span>Round-up label</span><input type="text" value={settings.shortfallFeeLabel} onChange={(event) => setSettings({ ...settings, shortfallFeeLabel: event.target.value })} /></label>
        <label><span>Allow manager bypass</span><input type="checkbox" checked={settings.allowManagerBypass} onChange={(event) => setSettings({ ...settings, allowManagerBypass: event.target.checked })} /></label>
        <label><span>Notify management on bypass</span><input type="checkbox" checked={settings.notifyManagementOnBypass} onChange={(event) => setSettings({ ...settings, notifyManagementOnBypass: event.target.checked })} /></label>
      </article>

      <article className="posSettingsCard">
        <h2>Tax-inclusive pricing</h2>
        <label><span>Menu prices include tax</span><input type="checkbox" checked={settings.pricesIncludeTax} onChange={(event) => setSettings({ ...settings, pricesIncludeTax: event.target.checked })} /></label>
        <label><span>Tax rate</span><div className="posMoneyInput"><input type="number" min="0" max="100" step="0.001" value={(settings.taxRateBps / 100).toFixed(3)} onChange={(event) => setSettings({ ...settings, taxRateBps: Math.max(0, Math.round(Number(event.target.value) * 100)) })} /><b>%</b></div></label>
        <label><span>Delivery fee taxable</span><input type="checkbox" checked={settings.deliveryFeeTaxable} onChange={(event) => setSettings({ ...settings, deliveryFeeTaxable: event.target.checked })} /></label>
        <label><span>Minimum round-up taxable</span><input type="checkbox" checked={settings.minimumAdjustmentTaxable} onChange={(event) => setSettings({ ...settings, minimumAdjustmentTaxable: event.target.checked })} /></label>
        {!settings.taxRateConfigured && <p className="posSettingsWarning">Tax rate has not yet been explicitly configured. Set it before any production testing.</p>}
      </article>
    </section>

    <section className="posSettingsCard posBandCard">
      <div className="posSettingsHeading"><div><p className="posDevEyebrow">Distance pricing</p><h2>Delivery fee bands</h2></div><button type="button" onClick={addBand}>Add band</button></div>
      <div className="posBandTable">
        <div className="posBandHeader"><span>Over miles</span><span>Through miles</span><span>Fee</span><span></span></div>
        {settings.feeBands.map((band, index) => <div className="posBandRow" key={`${band.minMilesExclusive}-${index}`}>
          <input type="number" min="0" step="0.1" value={band.minMilesExclusive} onChange={(event) => updateBand(index, { minMilesExclusive: Number(event.target.value) })} />
          <input type="number" min="0" step="0.1" value={band.maxMilesInclusive} onChange={(event) => {
            const nextMax = Number(event.target.value);
            updateBand(index, { maxMilesInclusive: nextMax });
            if (index === settings.feeBands.length - 1) setSettings((current) => current ? { ...current, maxDistanceMiles: nextMax } : current);
          }} />
          <div className="posMoneyInput"><b>$</b><input type="number" min="0" step="0.01" value={dollars(band.feeCents)} onChange={(event) => updateBand(index, { feeCents: cents(event.target.value) })} /></div>
          <button type="button" disabled={settings.feeBands.length <= 1} onClick={() => removeBand(index)}>Remove</button>
        </div>)}
      </div>
      <p className="posSettingsHint">With the current $20 minimum, the merchandise threshold is effectively $16.00 in the $4 delivery zone, $12.25 in the $7.75 zone, and $10.00 in the $10 zone. Bands remain editable.</p>
    </section>

    {message && <div className="posSettingsMessage">{message}</div>}
    {error && <div className="posSettingsMessage error">{error}</div>}
    <div className="posSettingsActions"><button type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</button></div>
  </main>;
}
