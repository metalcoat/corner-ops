import type { Metadata } from "next";
import ScreenGate from "../screen-gate";
import StatusBoard from "./status-board";
import "./status-board.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Status board | Corner Deli" };

/** The staff status monitor: signs in once and never times out. */
export default function StatusBoardPage() {
  return (
    <ScreenGate kind="board">
      <StatusBoard />
    </ScreenGate>
  );
}
