import type { ReactNode } from "react";
import EmployeeAttendanceBadge from "./attendance-badge";
import EmployeeInstallPrompt from "./install-prompt";
import EmployeeMessagesDock from "./messages-dock";
import EmployeePinController from "./pin-controller";
import ProfilePhotoOptimizer from "./profile-photo-optimizer";
import "./employee-nav.css";
import "./portal-layout-fixes.css";

export default function EmployeeLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="employeePortalFrame">
      <ProfilePhotoOptimizer />
      <EmployeePinController />
      <EmployeeMessagesDock />
      <EmployeeInstallPrompt />
      <nav className="employeePortalNav" aria-label="Employee Hub navigation">
        <a href="/employee">Home</a>
        <a href="/scan">Scan document</a>
        <a href="/employee/forms">Forms</a>
        <a href="/employee/handbook">Handbook</a>
        <a href="/employee/direct-deposit">Direct deposit</a>
        <EmployeeAttendanceBadge />
        <a href="/employee/forgot-pin">Forgot PIN</a>
      </nav>
      <div className="employeePortalContent">{children}</div>
    </div>
  );
}
