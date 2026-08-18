import type { ReactNode } from "react";

export default function DeliBoardLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <>
    <style>{`.globalOwnerNav{display:none!important}body{background:#07111f!important}`}</style>
    {children}
  </>;
}
