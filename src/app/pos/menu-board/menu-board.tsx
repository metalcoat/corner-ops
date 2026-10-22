"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { SLOT_SECONDS, type Board, type BoardBlock, type BoardPrice, type BoardScreen } from "@/lib/menu-board-layout";

const POLL_MS = 60_000;
const CYCLE_MS = SLOT_SECONDS.reduce((sum, s) => sum + s, 0) * 1000;
const TICKER_MS = 48_000; // matches the mbCrawl animation in menu-board.css
const LOGO = "/corner-deli-logo.png";

type Props = { initial: Board & { version?: string }; tv: number; season: string | null; qrSvg: string; lowMotion: boolean };

const vars = (style: Record<string, string | number>) => style as CSSProperties;

/** Every price on the board by position, so a price the POS just changed can flash. */
function priceMap(board: Board): Map<string, string> {
  const map = new Map<string, string>();
  for (const screen of board.screens) {
    if (screen.kind !== "menu") continue;
    for (const block of screen.columns.flat()) {
      if (block.kind === "grid") block.rows.forEach((row) => row.prices.forEach((p, i) => p && map.set(`${screen.key}|${block.title}|${row.label}|${i}`, p.text)));
      else if (block.kind === "list") block.rows.forEach((row) => map.set(`${screen.key}|${block.title}|${row.label}|0`, row.price.text));
    }
  }
  return map;
}

function Fx({ season }: { season: string }) {
  if (season === "halloween") {
    return (
      <div className="mbFx">
        {[0, 1, 2].map((i) => <span key={`f${i}`} className="fog" style={{ left: `${i * 30}%`, animationDuration: `${26 + i * 9}s`, animationDelay: `${-i * 7}s` }} />)}
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <span key={`b${i}`} className="bat" style={vars({ left: 0, top: `${80 + ((i * 137) % 700)}px`, animationDuration: `${11 + ((i * 5) % 9)}s`, animationDelay: `${-((i * 4) % 13)}s`, "--sc": 0.5 + (i % 3) * 0.3 })} />
        ))}
      </div>
    );
  }
  const kind = season === "thanksgiving" ? "leaf" : season === "christmas" ? "snow" : "";
  if (!kind) return null;
  const leafColors = ["#e8622a", "#f4b43a", "#b4421c", "#d98b2b"];
  return (
    <div className="mbFx">
      {Array.from({ length: 18 }, (_, i) => (
        <span key={i} className={kind} style={vars({
          left: `${(i * 37) % 100}%`, animationDuration: `${9 + ((i * 7) % 8)}s`, animationDelay: `${-((i * 13) % 17)}s`,
          "--dx": `${((i % 5) - 2) * 90}px`, "--rot": `${(i % 2 ? 1 : -1) * (180 + i * 20)}deg`,
          ...(kind === "leaf" ? { background: leafColors[i % 4] } : { transform: `scale(${0.6 + (i % 4) * 0.25})` }),
        })} />
      ))}
    </div>
  );
}

function Price({ price, flash, i }: { price: BoardPrice; flash: boolean; i: number }) {
  return <span className={`p${price.soldOut ? " out" : ""}${flash ? " mbFlash" : ""}`} style={vars({ "--i": i })}>{price.text}</span>;
}

function Block({ block, screenKey, flashes, counter }: { block: BoardBlock; screenKey: string; flashes: Set<string>; counter: { n: number } }) {
  if (block.kind === "feature") {
    return <div className="mbFeature" style={vars({ "--i": counter.n++ })}><b>{block.title}</b><span>{block.text}</span></div>;
  }
  const head = <h3 style={vars({ "--i": counter.n++ })}>{block.title}{block.note && <small>{block.note}</small>}</h3>;
  if (block.kind === "grid") {
    const headI = counter.n++;
    return (
      <div className="mbBlock">
        {head}
        <div className="mbGrid" style={{ gridTemplateColumns: `1fr repeat(${block.columns.length}, ${block.columns.length > 2 ? 140 : 150}px)` }}>
          <span className="h" style={vars({ "--i": headI })} />
          {block.columns.map((c) => <span key={c} className="h" style={vars({ "--i": headI })}>{c}</span>)}
          {block.rows.flatMap((row) => {
            const i = counter.n++;
            return [
              <span key={row.label} className="n" style={vars({ "--i": i })}>{row.label}</span>,
              ...row.prices.map((p, k) => p
                ? <Price key={`${row.label}${k}`} price={p} i={i} flash={flashes.has(`${screenKey}|${block.title}|${row.label}|${k}`)} />
                : <span key={`${row.label}${k}`} className="na" style={vars({ "--i": i })}>–</span>),
            ];
          })}
        </div>
      </div>
    );
  }
  return (
    <div className="mbBlock">
      {head}
      {block.rows.map((row) => {
        const flash = flashes.has(`${screenKey}|${block.title}|${row.label}|0`);
        return (
          <div key={row.label} className={`mbRow${row.price.soldOut ? " out" : ""}`} style={vars({ "--i": counter.n++ })}>
            <span className="n">{row.label}{row.note && <> <span className="note">{row.note}</span></>}<span className="mbSold">SOLD OUT</span></span>
            <span className="d" />
            <span className={`p${flash ? " mbFlash" : ""}`}>{row.price.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function Screen({ screen, on, qrSvg, flashes }: { screen: BoardScreen; on: boolean; qrSvg: string; flashes: Set<string> }) {
  if (screen.kind === "promo") {
    const badge = screen.badgeText && <div className="mbBurst"><div><span>{screen.badgeLabel}</span><b>{screen.badgeText}</b></div></div>;
    return (
      <section className={`mbSlide mbPromo${on ? " on" : ""}`} aria-hidden={!on}>
        <div className={`inner${screen.photo ? " photo" : ""}`}>
          <div><div className="kicker">{screen.kicker}</div><h2>{screen.name}</h2><p>{screen.text}</p></div>
          {screen.photo ? (
            <div className="shot">
              <div className="frame">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={screen.photo} alt={screen.name} />
              </div>
              {badge}
              {screen.extras && <div className="label">{screen.extras}</div>}
            </div>
          ) : (
            <div className="art">
              <div className="ring" /><div className="ring b" />
              {screen.qr ? <div className="mbBurst qr" dangerouslySetInnerHTML={{ __html: qrSvg }} /> : badge}
            </div>
          )}
        </div>
      </section>
    );
  }
  const counter = { n: 0 };
  return (
    <section className={`mbSlide${on ? " on" : ""}`} aria-hidden={!on}>
      <div className="mbTop">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={LOGO} alt="Corner Deli" />
        <h2>{screen.title[0]}<em>{screen.title[1]}</em></h2>
        <div className="mbTag"><b>{screen.tag[0]}</b>{screen.tag[1]}</div>
      </div>
      <div className={`mbCols ${screen.layout}`}>
        {screen.columns.map((column, c) => (
          <div key={c}>{column.map((block) => <Block key={block.title} block={block} screenKey={screen.key} flashes={flashes} counter={counter} />)}</div>
        ))}
      </div>
    </section>
  );
}

export default function MenuBoard({ initial, tv, season, qrSvg, lowMotion }: Props) {
  const [board, setBoard] = useState(initial);
  const [cur, setCur] = useState(0);
  const [offline, setOffline] = useState(false);
  const [flashes, setFlashes] = useState<Set<string>>(new Set());
  const stage = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const version = useRef(initial.version ?? "");
  const prices = useRef(priceMap(initial));
  // Server clock minus this TV's clock, so every TV counts the same timeline.
  const offset = useRef(0);
  const track = useRef<HTMLDivElement>(null);

  // Scale the 1920x1080 board to whatever the screen is, centered.
  useEffect(() => {
    const fit = () => {
      if (!stage.current) return;
      const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      stage.current.style.transform = `translate(${(window.innerWidth - 1920 * scale) / 2}px, ${(window.innerHeight - 1080 * scale) / 2}px) scale(${scale})`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // New prices, sold-out marks and season from the POS every minute.
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const query = new URLSearchParams({ tv: String(tv), ...(season ? { season } : {}) });
        const sent = Date.now();
        const response = await fetch(`/api/pos/menu-board?${query}`, { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const next = (await response.json()) as Board & { version: string; serverNow: number };
        if (stopped) return;
        offset.current = next.serverNow - (sent + Date.now()) / 2;
        // Restart the ticker at the same point on every TV (a tiny jump at most, once a minute).
        const el = track.current;
        if (el) {
          el.style.animation = "none";
          void el.offsetWidth;
          el.style.animation = "";
          el.style.animationDelay = `-${(Date.now() + offset.current) % TICKER_MS}ms`;
        }
        setOffline(false);
        if (next.version === version.current) return;
        version.current = next.version;
        const nextPrices = priceMap(next);
        setFlashes(new Set([...nextPrices].filter(([key, text]) => prices.current.has(key) && prices.current.get(key) !== text).map(([key]) => key)));
        prices.current = nextPrices;
        setBoard(next);
      } catch {
        if (!stopped) setOffline(true); // keep showing the last menu
      }
    };
    void poll(); // right away, to set the clock
    const timer = window.setInterval(() => void poll(), POLL_MS);
    // Reload once a day (4 AM) so a long-running kiosk picks up new versions and frees memory.
    const reload = window.setInterval(() => {
      if (new Date().getHours() === 4 && performance.now() > 3_600_000) window.location.reload();
    }, 600_000);
    return () => { stopped = true; window.clearInterval(timer); window.clearInterval(reload); };
  }, [tv, season]);

  const count = board.screens.length;
  const showing = count ? cur % count : 0;

  // Rotation on the shared timeline: slot n of every TV runs SLOT_SECONDS[n], counted from the
  // server's clock, so all the TVs change screens together. The bar shows the slot's progress.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      let at = (Date.now() + offset.current) % CYCLE_MS;
      let slot = 0;
      while (slot < SLOT_SECONDS.length - 1 && at >= SLOT_SECONDS[slot] * 1000) at -= SLOT_SECONDS[slot++] * 1000;
      if (bar.current) bar.current.style.width = `${Math.min(100, at / (SLOT_SECONDS[slot] * 10))}%`;
      setCur(slot);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // Two copies side by side so the crawl loops without a gap.
  const ticker = useMemo(() => [0, 1].flatMap((copy) => board.ticker.map(([bold, text], i) => <span key={`${copy}-${i}`}><b>{bold}</b> <i>·</i> {text}</span>)), [board.ticker]);

  return (
    <main className={`menuBoard${lowMotion ? " low" : ""}`}>
      <div ref={stage} className="mbStage" data-season={board.season}>
        {board.ribbon && <div className="mbRibbon">{board.ribbon}</div>}
        {!lowMotion && <Fx season={board.season} />}
        {board.screens.map((screen, i) => <Screen key={`${i}-${screen.kind}-${screen.key}`} screen={screen} on={i === showing} qrSvg={qrSvg} flashes={flashes} />)}
        <div ref={bar} className="mbBar" />
        <div className="mbFoot">
          <span className="mbQrBox"><span className="qr" dangerouslySetInnerHTML={{ __html: qrSvg }} /><span>Order<br />ahead</span></span>
          <div className="mbTicker"><div ref={track} className="mbTrack">{ticker}</div></div>
          <span className="mbDots">{board.screens.map((s, i) => <span key={i} className={i === showing ? "on" : ""} />)}</span>
        </div>
        {offline && <i className="mbOffline" title="Can't reach the store server" />}
      </div>
    </main>
  );
}
