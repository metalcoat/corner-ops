import type { Metadata } from "next";
import "./pos-home.css";

export const metadata: Metadata = { title: "Corner Deli" };

const MAIN = [
  { href: "/pos/deli", icon: "🧾", title: "POS", detail: "Take orders, phone orders and payments." },
  { href: "/pos/labels", icon: "🏷️", title: "Labels", detail: "Print the sticker label for each sub and pizza." },
  { href: "/pos/board", icon: "📺", title: "Dashboard", detail: "Order status board for the monitor. Stays signed in." },
];
const OTHER = [
  { href: "/pos/deli/kitchen", title: "Kitchen display" },
  { href: "/display/deli", title: "Customer display" },
  { href: "/kiosk/deli", title: "Self-order kiosk" },
  { href: "/employee/deliveries", title: "Driver tablet" },
  { href: "/pos/deli/dashboard", title: "Manager dashboard" },
  { href: "/pos/deli/settings", title: "Settings" },
  { href: "/setup", title: "Set up a tablet" },
  { href: "/pos/tiki", title: "Tiki POS" },
  { href: "/pos/restaurant", title: "Restaurant table service" },
  { href: "/ops/people", title: "Employees" },
];

export default function PosHome() {
  return (
    <main className="posHome">
      <header>
        <p>CORNER DELI</p>
        <h1>What are you opening?</h1>
      </header>
      <nav className="posHomeMain" aria-label="Main screens">
        {MAIN.map((item) => (
          <a key={item.href} href={item.href}>
            <span aria-hidden="true">{item.icon}</span>
            <strong>{item.title}</strong>
            <small>{item.detail}</small>
          </a>
        ))}
      </nav>
      <nav className="posHomeOther" aria-label="Other screens">
        {OTHER.map((item) => (
          <a key={item.href} href={item.href}>{item.title}</a>
        ))}
      </nav>
    </main>
  );
}
