import type { ReactNode } from "react";
import EmployeeMessagesDock from "./messages-dock";
import EmployeePinController from "./pin-controller";
import "./employee-nav.css";

export default function EmployeeLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="employeePortalFrame">
      <EmployeePinController />
      <EmployeeMessagesDock />
      <nav className="employeePortalNav" aria-label="Employee Hub navigation">
        <a href="/employee">Home</a>
        <a href="/employee/forms">Forms</a>
        <a href="/employee/direct-deposit">Direct deposit</a>
        <a href="/employee/attendance">Attendance</a>
        <a href="/employee/forgot-pin">Reset PIN</a>
      </nav>
      <div className="employeePortalContent">{children}</div>
    </div>
  );
}
