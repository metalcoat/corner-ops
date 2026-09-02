import type { ReactNode } from "react";
import MissingShiftPanel from "./missing-shift-panel";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default function PayrollControlLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <><MissingShiftPanel />{children}</>;
}
