"use client";
// One place to set up any tablet: open /setup on it, tap what it is, and it
// remembers. Station-specific screens (POS register, customer display, label
// station) ask which station or printer, and save that on this tablet.
import { useEffect, useState } from "react";

type Options = {
  stations: Array<{ name: string; key: string; payment: boolean; customerDisplay: boolean }>;
  labelPrinters: Array<{ id: string; name: string }>;
};
type Choice = "station" | "payment-station" | "display" | "label-printer";
type View = {
  id: string;
  name: string;
  what: string;
  href: string;
  where: "store" | "anywhere";
  choose?: Choice;
  tips: string[];
};
type Saved = { id: string; name: string; href: string; detail?: string };

const VIEWS: View[] = [
  { id: "pos", name: "POS register", what: "Take orders, phone orders and payments at the counter.", href: "/pos/deli", where: "store", choose: "station", tips: ["Add to Home Screen so it opens full screen.", "Turn off auto-lock, or set it to the longest time."] },
  { id: "payments", name: "Payment station", what: "The front register that takes card and cash payments sent from other POS tablets.", href: "/pos/deli/payments", where: "store", choose: "payment-station", tips: ["Pick the station that has the card terminal and cash drawer."] },
  { id: "kitchen", name: "Kitchen display (KDS)", what: "Live tickets for the line: new, in progress, ready.", href: "/pos/deli/kitchen", where: "store", tips: ["Mount it where the whole line can see it.", "Leave the screen on; it refreshes by itself."] },
  { id: "labels", name: "Label station", what: "Tap a sub or pizza to print its sticker label; reprint one if it was stuck on the wrong box.", href: "/pos/labels", where: "store", choose: "label-printer", tips: ["Use one tablet per label printer (for example one at subs, one at pizza). It never times out."] },
  { id: "display", name: "Customer display (CDS)", what: "The customer-facing screen at a register: order total, tip, signature, receipt choice.", href: "/display/deli", where: "store", choose: "display", tips: ["Choose the register it faces.", "Use Android screen pinning or a kiosk browser so customers can't leave the page."] },
  { id: "kiosk", name: "Self-order kiosk", what: "Customers order and pay on their own.", href: "/kiosk/deli", where: "store", tips: ["Use Android screen pinning or a kiosk browser (like Fully Kiosk) to lock it to this page."] },
  { id: "board", name: "Deli board", what: "The big order board for staff.", href: "/deli-board", where: "store", tips: ["Staff sign in with their PIN."] },
  { id: "board", name: "Status board", what: "The order status monitor for staff: in the kitchen, ready, out for delivery, coming up. Never times out.", href: "/pos/board", where: "store", tips: ["Best on a computer connected to a TV or monitor; make the browser full screen (F11)."] },
  { id: "dashboard", name: "Manager dashboard", what: "Today's sales, open orders, deliveries and tasks.", href: "/pos/deli/dashboard", where: "store", tips: [] },
  { id: "driver", name: "Driver tablet", what: "Deliveries in the car: who, where, what to collect, call the customer, navigate.", href: "/employee/deliveries", where: "anywhere", tips: ["Install the 3CX app and set it as the default phone app so calls go out on the deli line.", "Allow location access, and keep it in split screen with Google Maps so tracking keeps running."] },
  { id: "dispatch", name: "Dispatch board", what: "Managers assign deliveries and watch drivers on the map.", href: "/employee/deliveries?dispatch=1", where: "anywhere", tips: [] },
];

const SAVED_KEY = "corner-ops-device-setup";
const STATION_KEY = "corner-ops-station-key";
const LABEL_KEY = "corner-ops-label-printer";
const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

export default function DeviceSetup() {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [changing, setChanging] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [picking, setPicking] = useState<View | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    const raw = store.get(SAVED_KEY);
    if (raw)
      try {
        const value = JSON.parse(raw) as Saved;
        if (value?.href?.startsWith("/")) {
          setSaved(value);
          if (!new URLSearchParams(window.location.search).has("change")) setCountdown(5);
          else setChanging(true);
        }
      } catch {}
    fetch("/api/ordering/device-setup", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 403) throw new Error("Station choices only load on the store's Wi-Fi.");
        if (!response.ok) throw new Error("Station choices could not be loaded.");
        setOptions(await response.json());
      })
      .catch((error) => setOptionsError(error instanceof Error ? error.message : "Station choices could not be loaded."));
  }, []);

  // A tablet that is already set up opens its screen by itself.
  useEffect(() => {
    if (countdown === null || changing || !saved) return;
    if (countdown <= 0) {
      window.location.href = saved.href;
      return;
    }
    const timer = window.setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, changing, saved]);

  function finish(view: View, href: string, detail?: string) {
    const value: Saved = { id: view.id, name: view.name, href, detail };
    store.set(SAVED_KEY, JSON.stringify(value));
    window.location.href = href;
  }

  function choose(view: View) {
    if (!view.choose) return finish(view, view.href);
    setPicking(view);
  }

  function choices(view: View) {
    if (!options) return [];
    if (view.choose === "label-printer")
      return options.labelPrinters.map((printer) => ({
        label: printer.name,
        go: () => {
          store.set(LABEL_KEY, printer.id);
          finish(view, `${view.href}?printer=${encodeURIComponent(printer.id)}`, printer.name);
        },
      }));
    const stations = options.stations.filter((station) =>
      view.choose === "payment-station" ? station.payment : view.choose === "display" ? station.customerDisplay : true,
    );
    return stations.map((station) => ({
      label: `${station.name}${station.payment ? " · takes payments" : ""}`,
      go: () => {
        if (view.choose === "display") finish(view, `${view.href}?station=${encodeURIComponent(station.key)}`, station.name);
        else {
          store.set(STATION_KEY, station.key);
          finish(view, view.href, station.name);
        }
      },
    }));
  }

  if (saved && !changing && countdown !== null)
    return (
      <main className="deviceSetup">
        <section className="setupCurrent">
          <p className="eyebrow">THIS TABLET IS SET UP AS</p>
          <h1>{saved.name}</h1>
          {saved.detail && <p className="setupDetail">{saved.detail}</p>}
          <p>Opening in {countdown}…</p>
          <div className="setupActions">
            <a className="setupPrimary" href={saved.href}>Open now</a>
            <button onClick={() => setChanging(true)}>Change what this tablet is</button>
          </div>
        </section>
      </main>
    );

  if (picking) {
    const list = choices(picking);
    const noun = picking.choose === "label-printer" ? "label printer" : "register";
    return (
      <main className="deviceSetup">
        <button className="setupBack" onClick={() => setPicking(null)}>‹ Back</button>
        <h1>{picking.name}: which {noun}?</h1>
        {optionsError ? (
          <p className="setupWarning">{optionsError}</p>
        ) : !options ? (
          <p>Loading…</p>
        ) : list.length ? (
          <div className="setupChoices">
            {list.map((item) => (
              <button key={item.label} onClick={item.go}>{item.label}</button>
            ))}
          </div>
        ) : (
          <p className="setupWarning">
            {picking.choose === "label-printer"
              ? "No label printer is set up yet. Add one in Settings → Printers & devices (choose “Food labels”)."
              : picking.choose === "display"
                ? "No register has a customer display turned on. Turn it on for a register in Settings → Printers & devices."
                : "No registers are set up yet. Add one in Settings → Printers & devices."}
          </p>
        )}
        {picking.choose !== "display" && picking.choose !== "label-printer" && (
          <button className="setupSkip" onClick={() => finish(picking, picking.href)}>Skip — choose later</button>
        )}
      </main>
    );
  }

  const groups: Array<[string, View[]]> = [
    ["In the store", VIEWS.filter((view) => view.where === "store")],
    ["Anywhere", VIEWS.filter((view) => view.where === "anywhere")],
  ];
  return (
    <main className="deviceSetup">
      <header>
        <p className="eyebrow">CORNER DELI</p>
        <h1>What is this tablet?</h1>
        <p>Tap one. This tablet remembers it, and opening {origin ? <code>{origin}/setup</code> : "/setup"} again takes it straight there.</p>
      </header>
      {optionsError && <p className="setupWarning">{optionsError} In-store screens still open, but you can't pick a register here.</p>}
      {groups.map(([title, views]) => (
        <section key={title}>
          <h2>{title}</h2>
          <div className="setupGrid">
            {views.map((view) => (
              <button key={view.id} className={`setupTile${saved?.id === view.id ? " current" : ""}`} onClick={() => choose(view)}>
                <strong>{view.name}</strong>
                <span>{view.what}</span>
                {view.tips.length > 0 && (
                  <ul>
                    {view.tips.map((tip) => (
                      <li key={tip}>{tip}</li>
                    ))}
                  </ul>
                )}
                <code>{view.href}</code>
              </button>
            ))}
          </div>
        </section>
      ))}
      <footer className="setupFooter">
        <strong>Every tablet:</strong> open <code>{origin || ""}/setup</code>, tap what it is, then use your browser&apos;s “Add to Home Screen” so it opens like an app.
      </footer>
    </main>
  );
}
