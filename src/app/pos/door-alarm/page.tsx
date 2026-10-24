import type { Metadata } from "next";
import DoorAlarm from "./door-alarm";
import "./door-alarm.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Door alarm | Corner Deli" };

/**
 * An always-open page for a back-office computer: a loud chime each time the
 * entrance camera records a walk-in. Store network only, like the rest of /pos.
 */
export default function DoorAlarmPage() {
  return <DoorAlarm />;
}
