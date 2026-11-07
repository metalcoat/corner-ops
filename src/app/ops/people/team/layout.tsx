import type { ReactNode } from "react";
import EmployeeEditorOverlay from "./employee-editor-overlay";

export default function EmployeesLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <>
    <EmployeeEditorOverlay />
    {children}
  </>;
}
