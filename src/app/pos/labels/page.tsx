import type { Metadata } from "next";
import ScreenGate from "../screen-gate";
import LabelStationClient from "../deli/labels/label-station-client";
import "../deli/labels/labels.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Label station | Corner Deli" };

/** The label station on its own (no POS around it), so it never locks or times out. */
export default function LabelsPage() {
  return (
    <ScreenGate kind="labels">
      <LabelStationClient />
    </ScreenGate>
  );
}
