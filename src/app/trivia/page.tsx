import type { Metadata, Viewport } from "next";
import TriviaClient from "./trivia-client";
import "./trivia.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Lobby Trivia | Corner Deli", robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#174f36" };

/** Lobby trivia on a customer's phone, opened from the greeter TV's QR (?t= is that minute's code). */
export default async function TriviaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  return <TriviaClient token={typeof params.t === "string" ? params.t : ""} />;
}
