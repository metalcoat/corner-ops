import type { ReactNode } from "react";
import SchedulePublishConfirmFix from "./schedule-publish-confirm-fix";
import "./ops.css";
import "./interface-cleanup.css";

export default function OperationsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <>
    <SchedulePublishConfirmFix />
    {children}
  </>;
}
