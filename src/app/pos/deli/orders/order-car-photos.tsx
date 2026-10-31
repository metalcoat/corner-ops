"use client";
import { useCallback, useEffect, useState } from "react";
import { CarPhotoGrid, snapNow, type CarPhoto, type CarTabletRow } from "../settings/car-tablet-settings-client";

/** Car tablet photos on a delivery order, and (managers) a snap from the car for this order. */
export default function OrderCarPhotos({ orderId }: { orderId: string }) {
  const [photos, setPhotos] = useState<CarPhoto[] | null>(null);
  const [tablets, setTablets] = useState<CarTabletRow[]>([]);
  const [manager, setManager] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const [photoResponse, tabletResponse] = await Promise.all([
      fetch(`/api/ordering/car-tablets/photos?orderId=${encodeURIComponent(orderId)}`, { cache: "no-store" }),
      fetch("/api/ordering/car-tablets", { cache: "no-store" }),
    ]);
    if (photoResponse.ok) setPhotos((await photoResponse.json()).photos);
    if (tabletResponse.ok) {
      const payload = await tabletResponse.json();
      setTablets((payload.tablets as CarTabletRow[]).filter((tablet) => tablet.paired));
      setManager(Boolean(payload.manager));
    }
  }, [orderId]);
  useEffect(() => { void load(); }, [load]);
  if (!photos || (!photos.length && !(manager && tablets.length))) return null;
  return <div className="ocCarPhotos">
    <h3>Car tablet photos</h3>
    <CarPhotoGrid photos={photos} canDelete={manager} onChanged={() => void load()} />
    {manager && tablets.map((tablet) => <p key={tablet.id}>
      {tablet.name} ({tablet.online ? "online" : "offline"}):{" "}
      {(["cabin", "road", "both"] as const).map((camera) => <button key={camera} type="button" onClick={() => void snapNow(tablet.id, camera, orderId)
        .then(() => { setMessage("Asked the car for a photo."); window.setTimeout(() => void load(), 5000); })
        .catch((error: Error) => setMessage(error.message))}>Snap {camera}</button>)}
    </p>)}
    {message && <p role="status">{message}</p>}
  </div>;
}
