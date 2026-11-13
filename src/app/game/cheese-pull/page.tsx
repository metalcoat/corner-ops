import type { Metadata } from "next";
import CheesePullGame from "./cheese-pull-game";
import "./cheese-pull.css";

export const metadata: Metadata = {
  title: "Delivery Blaster | Corner Deli",
  description:
    "Blast through absurd Northern New York delivery obstacles and get the food to the customer.",
};

export default function CheesePullPage() {
  return <CheesePullGame />;
}
