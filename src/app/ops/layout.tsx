import type { ReactNode } from "react";
import "./ops.css";

export default function OperationsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <>
    <div className="opsUtilityNav">
      <a href="/ops">Operations</a>
      <a href="/ops/integrations">Scheduler & Integrations</a>
      <a href="/ops/bank-accounts">Bank Accounts</a>
      <a href="/">Documents</a>
    </div>
    {children}
  </>;
}