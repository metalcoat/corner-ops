import type { Metadata } from "next";
import DeliRampage from "./deli-rampage";
import "./deli-rampage.css";

export const metadata: Metadata = {
  title: "DELI RAMPAGE: One Star Monster",
  description: "The customers complained. You're sixty feet tall. A Corner Deli arcade game.",
};

export default function Page() {
  return <DeliRampage />;
}
