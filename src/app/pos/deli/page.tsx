import PosClient from "../pos-client";
import "../pos-separation.css";

export default function DeliPosPage() {
  const seconds = Number.parseInt(process.env.POS_IDLE_LOCK_SECONDS || "60", 10);
  return <PosClient business="Corner Deli" idleLockSeconds={Number.isFinite(seconds) ? seconds : 60} />;
}
