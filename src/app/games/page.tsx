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
    title: "Earn Your Jumbo: JUMBO RUSH",
    tag: "SWIPE · SLICE · SURVIVE",
    copy: "Slice every pizza flying out of the oven. Don't slice the ringing phone. Survive the rush and earn a Jumbo Cheese Pizza.",
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
  {
    href: "/game/deli-man",
    icon: "🥪",
    title: "DELI MAN: The Last Jumbo",
    tag: "RUN · JUMP · BLAST",
    copy: "Pick a boss, blast pickles, steal their weapon. Pothole Man, Goose Man and six more North Country menaces.",
    prize: "8 BOSSES · 1 KIOSK",
    color: "pizza",
  },
  {
    href: "/game/deli-rampage",
    icon: "👹",
    title: "DELI RAMPAGE: One Star Monster",
    tag: "CLIMB · PUNCH · CLOSE",
    copy: "The customers complained. You're sixty feet tall. Punch their buildings down and hand them a sub through the wall.",
    prize: "HIGH SCORE GLORY",
    color: "delivery",
  },
  {
    href: "/game/sub-mission",
    icon: "🛎️",
    title: "SUB-MISSION: Over the Counter",
    tag: "DUCK · DODGE · FEED",
    copy: "A hangry customer is reaching over the counter for your collar. Duck so they hit the sneeze guard, ring the bell, and feed them into a food coma.",
    prize: "EMPLOYEE OF THE MONTH",
    color: "pizza",
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
      </section>
      <footer>
        Prizes require a completed validated run. One-time codes. See each game
        for terms.
      </footer>
    </main>
  );
}
