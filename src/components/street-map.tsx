"use client";
// A small dependency-free slippy map: raster tiles plus markers, auto-fitted to
// the points it is given. Used by the customer delivery tracker and dispatch.
import { useEffect, useRef, useState } from "react";
import "./street-map.css";

export type MapPoint = {
  id: string;
  latitude: number;
  longitude: number;
  kind: "driver" | "home" | "store" | "stop";
  label?: string;
  /** Draws a soft circle of this radius (metres) around the point. */
  accuracyMeters?: number | null;
  stale?: boolean;
};

const TILE = 256;
const MAX_ZOOM = 17;
export const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const worldX = (longitude: number, zoom: number) => ((longitude + 180) / 360) * TILE * 2 ** zoom;
function worldY(latitude: number, zoom: number) {
  const rad = (Math.max(-85, Math.min(85, latitude)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * TILE * 2 ** zoom;
}
const metresPerPixel = (latitude: number, zoom: number) => (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;

/** The highest zoom at which every point fits inside the box, with padding. */
function fitZoom(points: MapPoint[], width: number, height: number) {
  if (points.length < 2) return 15;
  for (let zoom = MAX_ZOOM; zoom > 3; zoom--) {
    const xs = points.map((p) => worldX(p.longitude, zoom)), ys = points.map((p) => worldY(p.latitude, zoom));
    if (Math.max(...xs) - Math.min(...xs) <= width - 90 && Math.max(...ys) - Math.min(...ys) <= height - 90) return zoom;
  }
  return 4;
}

const ICONS: Record<MapPoint["kind"], string> = {
  driver: "M5 11l1.5-4.5A2 2 0 018.4 5h7.2a2 2 0 011.9 1.5L19 11v6a1 1 0 01-1 1h-1a1 1 0 01-1-1v-1H8v1a1 1 0 01-1 1H6a1 1 0 01-1-1zm2.2-1h9.6l-1-3.2a.6.6 0 00-.6-.4H8.8a.6.6 0 00-.6.4zM7.5 14a1.2 1.2 0 100-2.4 1.2 1.2 0 000 2.4zm9 0a1.2 1.2 0 100-2.4 1.2 1.2 0 000 2.4z",
  home: "M12 4l8 7h-2.5v8h-4v-5h-3v5h-4v-8H4z",
  store: "M4 9l1.5-4h13L20 9v1a2.5 2.5 0 01-4 2 2.5 2.5 0 01-4 0 2.5 2.5 0 01-4 0 2.5 2.5 0 01-4-2zm1.5 4.5a4 4 0 002.5.3V19h8v-5.2a4 4 0 002.5-.3V20a1 1 0 01-1 1H6.5a1 1 0 01-1-1z",
  stop: "M12 3a6 6 0 016 6c0 4.5-6 11-6 11S6 13.5 6 9a6 6 0 016-6zm0 3.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z",
};

export default function StreetMap({
  points,
  tileUrl,
  height = 320,
  label = "Delivery map",
}: {
  points: MapPoint[];
  tileUrl?: string | null;
  height?: number;
  label?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const usable = points.filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
  const template = tileUrl || DEFAULT_TILE_URL;
  let content = null;
  if (width > 0 && usable.length) {
    const zoom = fitZoom(usable, width, height);
    const xs = usable.map((p) => worldX(p.longitude, zoom)), ys = usable.map((p) => worldY(p.latitude, zoom));
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2, centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const left = centerX - width / 2, top = centerY - height / 2, count = 2 ** zoom;
    const tiles = [];
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height) / TILE); ty++) {
      if (ty < 0 || ty >= count) continue;
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width) / TILE); tx++) {
        const wrapped = ((tx % count) + count) % count;
        const src = template.replace("{z}", String(zoom)).replace("{x}", String(wrapped)).replace("{y}", String(ty));
        tiles.push(
          // eslint-disable-next-line @next/next/no-img-element
          <img key={`${zoom}/${tx}/${ty}`} src={src} alt="" draggable={false} style={{ left: tx * TILE - left, top: ty * TILE - top }} />,
        );
      }
    }
    content = (
      <>
        <div className="streetMapTiles">{tiles}</div>
        {usable.map((point) => {
          const x = worldX(point.longitude, zoom) - left, y = worldY(point.latitude, zoom) - top;
          const radius = point.accuracyMeters ? point.accuracyMeters / metresPerPixel(point.latitude, zoom) : 0;
          return (
            <div key={point.id} className={`streetMapMarker ${point.kind}${point.stale ? " stale" : ""}`} style={{ transform: `translate(${x}px, ${y}px)` }}>
              {radius > 14 && <i className="streetMapAccuracy" style={{ width: radius * 2, height: radius * 2 }} />}
              <span className="streetMapPin">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[point.kind]} /></svg>
              </span>
              {point.label && <b>{point.label}</b>}
            </div>
          );
        })}
      </>
    );
  }
  return (
    <div className="streetMap" ref={box} style={{ height }} role="img" aria-label={label}>
      {content}
      <small className="streetMapCredit">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors
      </small>
    </div>
  );
}
