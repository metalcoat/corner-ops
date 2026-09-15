import type { Metadata } from "next";
import Link from "next/link";
import { MenuAdTicker } from "./components/menu-ad-ticker";
import "./games.css";
export const metadata: Metadata = {
  title: "Corner Deli Arcade",
  description: "Play Corner Deli games and earn real food.",
};
const games = [
  {
    href: "/game/earn-your-jumbo",
    icon: "🍕",
    title: "Earn Your Jumbo",
    tag: "PIZZA GAUNTLET",
    copy: "Build pies, survive the rush, and earn a Jumbo Cheese Pizza.",
    prize: "FREE JUMBO CHEESE PIZZA",
    color: "pizza",
  },
  {
    href: "/game/corner-delivery-boy",
    icon: "🚙",
    title: "Corner Delivery Boy",
    tag: "DELIVERY CHAOS",
    copy: "Dodge wildlife, find the address, and survive customer logic.",
    prize: "FREE REGULAR SUB",
    color: "delivery",
  },
];
export default function Games() {
  return (
    <main className="games-hub">
      <header>
        <img
          className="games-logo"
          src="https://rezku-pos-upload.imgix.net/2e2a0810-d179-474b-a40b-e4104c60d8c1/olo/logo/jO52kF7dMM84upTQGozunTrduBxjbylAFeGYc8r_RT8.png?fit=max&auto=compress&fmt=png32&h=180"
          alt="Corner Deli"
        />
        <small>CORNER DELI PRESENTS</small>
        <h1>
          THE CORNER
          <br />
          <i>ARCADE</i>
        </h1>
        <p>Play hard. Survive the shift. Earn actual food.</p>
        <MenuAdTicker />
      </header>
      <section>
        {games.map((g) => (
          <Link href={g.href} className={g.color} key={g.href}>
            <div>{g.icon}</div>
            <small>{g.tag}</small>
            <h2>{g.title}</h2>
            <p>{g.copy}</p>
            <b>WIN: {g.prize}</b>
            <span>PLAY NOW →</span>
          </Link>
        ))}
        <article>
          <div>🔒</div>
          <small>COMING SOON</small>
          <h2>Next Shift</h2>
          <p>Something else at the deli will inevitably go wrong.</p>
        </article>
      </section>
      <footer>
        Prizes require a completed validated run. One-time codes. See each game
        for terms.
      </footer>
    </main>
  );
}
