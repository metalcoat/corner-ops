import type { Metadata } from "next";
import CheesePullGame from "./cheese-pull-game";
import "./cheese-pull.css";

export const metadata: Metadata = {
  title: "Cheese Pull: The Meltdown | Corner Deli",
  description:
    "Keep the mozzarella hot, stretchy, and away from airborne deli hazards.",
};

export default function CheesePullPage() {
  return <CheesePullGame />;
}
