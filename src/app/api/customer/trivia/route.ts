import { NextResponse } from "next/server";
import { readCustomerOrderingSession } from "@/lib/customer-ordering-session";
import { RateLimitError } from "@/lib/http";
import {
  TriviaError, answerTrivia, createTriviaPlayer, limitTriviaAnswer, limitTriviaJoin, limitTriviaScan, linkTriviaCustomer,
  nextTriviaQuestion, playerCookie, playerIdFrom, renameTriviaPlayer, triviaBoards, triviaDay, triviaEnabled, triviaPlayer,
  triviaScanValid, triviaTotals, visitCookie, visitEndsAt, type TriviaDay,
} from "@/lib/lobby-trivia";
import { TRIVIA_VISIT_MS, cleanTriviaName } from "@/lib/trivia-rules";

export const runtime = "nodejs";

// Lobby trivia on the customer's phone (/trivia). No sign-in: the phone is remembered by a signed cookie, and
// playing needs a scan of the greeter TV's QR in the last 30 minutes. Every answer is checked here.
// Self-authorized (under /api/customer): nothing here reads or changes anything but trivia rows.

async function state(playerId: number | null, playingUntil: number, day?: TriviaDay) {
  const [enabled, player] = await Promise.all([triviaEnabled(), triviaPlayer(playerId)]);
  const id = player?.id ?? null;
  return {
    enabled,
    playingUntil: enabled ? playingUntil : 0,
    player,
    day: id ? day ?? await triviaDay(id) : null,
    totals: id ? await triviaTotals(id) : null,
    boards: await triviaBoards(10, id),
  };
}

const json = (body: unknown, cookies: string[] = [], status = 200) => {
  const response = NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
  for (const value of cookies) response.headers.append("Set-Cookie", value);
  return response;
};

export async function GET(request: Request) {
  try {
    return json(await state(playerIdFrom(request), visitEndsAt(request)));
  } catch (error) {
    console.error("Lobby trivia state failed", error);
    return json({ error: "Trivia is unavailable right now." }, [], 503);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: string; token?: string; name?: string; questionId?: string; choice?: string };
    let playerId = playerIdFrom(request);
    let playingUntil = visitEndsAt(request);
    const cookies: string[] = [];
    const needVisit = () => { if (!playingUntil) throw new TriviaError("Scan the code on the TV to keep playing.", 403); };
    const needPlayer = async () => {
      if (!playerId || !(await triviaPlayer(playerId))) throw new TriviaError("Pick a nickname to start.", 401);
      return playerId;
    };

    switch (body.action) {
      case "scan": {
        await limitTriviaScan(request);
        if (!(await triviaEnabled())) throw new TriviaError("Trivia is paused right now. Check back another time!", 409);
        if (!triviaScanValid(String(body.token ?? ""))) throw new TriviaError("That code has expired. Scan the code on the TV again.", 403);
        playingUntil = Date.now() + TRIVIA_VISIT_MS;
        cookies.push(visitCookie());
        // Back for more: the next question shows straight away.
        if (playerId && (await triviaPlayer(playerId))) return json(await state(playerId, playingUntil, await nextTriviaQuestion(playerId)), cookies);
        return json(await state(playerId, playingUntil), cookies);
      }
      case "join": {
        needVisit();
        await limitTriviaJoin(request);
        const cleaned = cleanTriviaName(body.name);
        if ("error" in cleaned) throw new TriviaError(cleaned.error);
        if (playerId && (await triviaPlayer(playerId))) {
          await renameTriviaPlayer(playerId, cleaned.name);
        } else {
          playerId = (await createTriviaPlayer(cleaned.name)).id;
          // Signed in with a texted code on this phone already: carry on as that customer's player.
          const customer = readCustomerOrderingSession(request);
          if (customer?.customerId && customer.authenticatedAt) playerId = await linkTriviaCustomer(playerId, customer.customerId);
          cookies.push(playerCookie(playerId));
        }
        return json(await state(playerId, playingUntil, await nextTriviaQuestion(playerId)), cookies);
      }
      case "next": {
        needVisit();
        const id = await needPlayer();
        return json(await state(id, playingUntil, await nextTriviaQuestion(id)));
      }
      case "answer": {
        needVisit();
        const id = await needPlayer();
        await limitTriviaAnswer(request, id);
        const result = await answerTrivia(id, String(body.questionId ?? ""), String(body.choice ?? ""));
        return json({ result: { correct: result.correct, chosen: result.chosen, correctLetter: result.correctLetter, correctAnswer: result.correctAnswer }, ...(await state(id, playingUntil, result.day)) });
      }
      case "link": {
        const id = await needPlayer();
        const customer = readCustomerOrderingSession(request);
        if (!customer?.customerId || !customer.authenticatedAt) throw new TriviaError("Sign in with your phone number first.", 401);
        const kept = await linkTriviaCustomer(id, customer.customerId);
        if (kept !== id) cookies.push(playerCookie(kept));
        return json(await state(kept, playingUntil), cookies);
      }
      default:
        throw new TriviaError("Unknown action.");
    }
  } catch (error) {
    if (error instanceof TriviaError) return json({ error: error.message }, [], error.status);
    if (error instanceof RateLimitError) return json({ error: "Slow down a little and try again in a minute." }, [], 429);
    console.error("Lobby trivia request failed", error);
    return json({ error: "Trivia is unavailable right now." }, [], 503);
  }
}
