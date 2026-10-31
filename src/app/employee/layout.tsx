import type { ReactNode } from "react";
import { getEmployeeSession } from "@/lib/employee-auth";
import EmployeeAttendanceBadge from "./attendance-badge";
import EmployeeEmailPrompt from "./email-prompt";
import EmployeeInstallPrompt from "./install-prompt";
import EmployeeNotificationPrompt from "./notification-prompt";
import MessageNotificationRedirect from "./message-notification-redirect";
import EmployeePinController from "./pin-controller";
import ProfilePhotoOptimizer from "./profile-photo-optimizer";
import "./employee-nav.css";

export default async function EmployeeLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await getEmployeeSession();
  const manager = session?.business === "Corner Deli" && (session.posRole === "manager" || session.posRole === "owner");
  return (
    <div className="employeePortalFrame">
      <ProfilePhotoOptimizer />
      <MessageNotificationRedirect />
      <EmployeePinController />
      <EmployeeInstallPrompt />
      <nav className="employeePortalNav" aria-label="Employee Hub navigation">
        <a href="/employee">Home</a>
        {manager && <a href="/employee/manager">Daily report</a>}
        <a href="/employee/deliveries">My deliveries</a>
        <a href="/employee/stock">Stock sheet</a>
        <a href="/employee/messages">Messages</a>
        <a href="/scan">Scan document</a>
        <a href="/employee/forms">Forms</a>
        <a href="/employee/handbook">Handbook</a>
        <a href="/employee/direct-deposit">Direct deposit</a>
        <EmployeeAttendanceBadge />
        <a href="/employee/forgot-pin">Forgot PIN</a>
      </nav>
      <div className="employeePortalContent"><EmployeeEmailPrompt /><EmployeeNotificationPrompt />{children}</div>
    </div>
  );
}
