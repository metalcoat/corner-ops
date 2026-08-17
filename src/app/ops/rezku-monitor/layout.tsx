import type { ReactNode } from "react";
import RepairRezkuFeedButton from "./repair-feed-button";

export default function RezkuMonitorLayout({ children }: { children: ReactNode }) {
  return <>
    <div style={{ padding: "16px 24px 0" }}>
      <RepairRezkuFeedButton />
    </div>
    {children}
  </>;
}
