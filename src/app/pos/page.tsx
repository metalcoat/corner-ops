import type { Metadata } from "next";
import PosHomeDefault from "./pos-home-default";
import "./pos-home.css";

export const metadata: Metadata = { title: "Corner Deli", manifest: "/pos/deli/manifest.webmanifest" };

export type HomeItem = { href: string; title: string; detail?: string; icon?: string; manager?: boolean };

/** What each screen is for, grouped the way the store uses them (owner request 2026-10-30). */
const SECTIONS: Array<{ title: string; note?: string; items: HomeItem[] }> = [
  {
    title: "Front counter",
    items: [
      { href: "/pos/deli", icon: "🧾", title: "POS", detail: "Take orders, phone orders and payments." },
      { href: "/pos/deli/kitchen", icon: "🍳", title: "Kitchen display", detail: "Tickets for the line." },
      { href: "/display/deli", icon: "🖥️", title: "Customer display", detail: "Facing the customer: order, tip, receipt." },
      { href: "/pos/labels", icon: "🏷️", title: "Labels", detail: "Sticker label for each sub and pizza." },
      { href: "/pos/board", icon: "📺", title: "Status board", detail: "Order status for the monitor. Stays signed in." },
      { href: "/kiosk/deli", icon: "🙋", title: "Self-order kiosk", detail: "Customers order themselves." },
    ],
  },
  {
    title: "Manager",
    note: "Asks for a manager PIN.",
    items: [
      { href: "/pos/dashboard", icon: "📊", title: "Store dashboard", detail: "Car tracking, phone, orders, deliveries.", manager: true },
      { href: "/pos/deli/orders", icon: "📋", title: "Order center", detail: "Find, reopen, void and refund orders.", manager: true },
      { href: "/pos/deli/reports", icon: "📈", title: "Reports", detail: "Sales, tips and labor.", manager: true },
      { href: "/pos/deli/settings", icon: "⚙️", title: "Settings", detail: "Menu, printers, delivery, promotions.", manager: true },
      { href: "/pos/deli/settings/car-tablet", icon: "🚗", title: "Car tablet", detail: "Pair, status, photos, snap now.", manager: true },
      { href: "/pos/deli/settings/route-test", icon: "🗺️", title: "Route tester", detail: "Check the route for any address.", manager: true },
      { href: "/pos/deli/inventory/costs", icon: "🧮", title: "Supplier costs", detail: "Prices from Sysco, US Foods, PFG.", manager: true },
      { href: "/ops/people", icon: "👥", title: "Employees", detail: "Staff, schedules, payroll (office login).", manager: true },
    ],
  },
  {
    title: "Drivers",
    items: [
      { href: "/employee/deliveries", icon: "📦", title: "My deliveries", detail: "Driver phone page: deliveries and GPS." },
      { href: "/employee/deliveries?dispatch=1", icon: "🧭", title: "Dispatch", detail: "Assign deliveries to drivers.", manager: true },
      { href: "/downloads/corner-ops-car-tablet.apk", icon: "⬇️", title: "Car tablet app", detail: "Download for the delivery car tablet." },
    ],
  },
  {
    title: "Setup & other stores",
    items: [
      { href: "/setup", title: "Set up a tablet" },
      { href: "/employee/stock", title: "Stock sheet" },
      { href: "/pos/tiki", title: "Tiki POS" },
      { href: "/pos/restaurant", title: "Restaurant table service" },
    ],
  },
];

/** The store's home screen: every screen by area, and (per device) which one to open straight away. */
export default function PosHome() {
  const choices = SECTIONS.flatMap((section) => section.items).filter((item) => item.icon && !item.href.startsWith("/downloads"));
  return (
    <main className="posHome">
      <header>
        <p>CORNER DELI</p>
        <h1>What are you opening?</h1>
      </header>
      {SECTIONS.map((section) => (
        <section key={section.title} className={`posHomeSection${section.items.some((item) => item.icon) ? "" : " compact"}`}>
          <h2>{section.title}{section.note && <small>{section.note}</small>}</h2>
          <nav aria-label={section.title}>
            {section.items.map((item) => (
              <a key={item.href} href={item.href}>
                {item.icon && <span aria-hidden="true">{item.icon}</span>}
                <strong>{item.title}{item.manager && <em>Manager</em>}</strong>
                {item.detail && <small>{item.detail}</small>}
              </a>
            ))}
          </nav>
        </section>
      ))}
      <PosHomeDefault choices={choices.map(({ href, title }) => ({ href, title }))} />
    </main>
  );
}
