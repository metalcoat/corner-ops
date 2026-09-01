"use client";

import { useEffect } from "react";

export default function MessageNotificationRedirect() {
  useEffect(() => {
    if (window.location.pathname === "/employee" && window.location.hash === "#messages") {
      window.location.replace("/employee/messages");
    }
  }, []);
  return null;
}
