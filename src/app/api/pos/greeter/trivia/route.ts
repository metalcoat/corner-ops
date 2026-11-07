import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { currentTriviaLink, triviaBoards, triviaEnabled, triviaLive } from "@/lib/lobby-trivia";

export const runtime = "nodejs";

// The greeter TV polls this every few seconds (store network only, like the rest of /api/pos): this minute's
// trivia QR, the top 5 Today / This month / This year, and who just got one right. Off = { enabled: false }.
export async function GET() {
  try {
    if (!(await triviaEnabled())) return NextResponse.json({ enabled: false }, { headers: { "cache-control": "no-store" } });
    const link = currentTriviaLink();
    const [qrSvg, boards, live] = await Promise.all([
      QRCode.toString(link.url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#111111", light: "#ffffff" } }),
      triviaBoards(5),
      triviaLive(),
    ]);
    return NextResponse.json({ enabled: true, qrSvg, expiresAt: link.expiresAt, boards, ...live }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Greeter trivia unavailable", error);
    return NextResponse.json({ error: "Trivia is temporarily unavailable." }, { status: 503 });
  }
}
