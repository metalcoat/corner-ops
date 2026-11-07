"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import "./setup.css";

/** On every Employee Hub page: a new hire whose setup isn't finished is told what's left. */
export default function SetupBanner() {
  const pathname = usePathname();
  const [stillToDo, setStillToDo] = useState<string[]>([]);
  const hidden = pathname.startsWith("/employee/setup") || pathname.startsWith("/employee/welcome");

  useEffect(() => {
    if (hidden) return;
    fetch("/api/employee/onboarding?mine=1", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { onboarding?: { stillToDo: string[] } | null } | null) => setStillToDo(payload?.onboarding?.stillToDo || []))
      .catch(() => setStillToDo([]));
  }, [hidden, pathname]);

  if (hidden || !stillToDo.length) return null;
  return <div className="setupBanner" role="status">
    <span><strong>Your new-hire setup isn&apos;t finished.</strong> Still to do: {stillToDo.join(", ")}. We can&apos;t schedule you until it&apos;s complete.</span>
    <a href="/employee/setup">Continue setup →</a>
  </div>;
}
