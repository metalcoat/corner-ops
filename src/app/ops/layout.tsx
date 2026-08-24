import type { ReactNode } from "react";
import "./ops.css";
import "./interface-cleanup.css";

export default function OperationsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <>{children}</>;
}
