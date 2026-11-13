import type { Metadata } from "next";
import ScreenGate from "../screen-gate";
import ChecklistsScreen from "./checklists-screen";
import "./checklists.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Checklists | Corner Deli" };

/** Opening / closing checklists and the deli salad log, for a touch screen in the deli. Signs in once and stays on. */
export default function ChecklistsPage() {
  return (
    <ScreenGate kind="checklists">
      <ChecklistsScreen />
    </ScreenGate>
  );
}
