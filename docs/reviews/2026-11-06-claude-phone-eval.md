# Claude phone ordering eval: text only, dev (2026-11-06)

**Question:** Can Claude take phone orders as well as the current Gemini Live line (`gemini-3.1-flash-live-preview`)?

**Short answer:** On order accuracy, yes. Claude Sonnet 5.5 got clearly more orders right than Gemini on the same calls. On speed, no, not yet. Claude's first words came 2 to 3 seconds after the caller finished, and that's before any speech-to-text or text-to-speech. Gemini's first audio comes about 0.75 seconds after the caller stops talking. A voice pilot is worth building only if it is built around that delay (details below).

## How it was run

- `npm run eval:claude-phone` (`scripts/claude-phone-eval/`). It sends Claude the scripted caller lines one turn at a time and plays Claude's side of the call.
- Claude gets the same instructions the Gemini bridge gets from `/api/internal/ai-phone` (`buildPhoneInstructions` plus the `complete_call` line). The store state is fixed to open, with the usual wait times.
- Claude also gets the same tools: the ordering MCP `tools/list`, converted the way `declarations()` in `asterisk/gemini-phone.py` does it. The bridge fills in `callId`, and the bridge-only tools `request_human_handoff`, `request_secure_voice_payment` and `complete_call` are added. Tool results go through the same `voice_safe_tool_result` compaction that Gemini sees.
- Tools run in-process against the dev database, one transaction per conversation, always rolled back. Payment, transfer, `send` and `complete_call` are stubbed, so nothing was charged, sent to the kitchen or printed. I checked afterwards: no rows were left behind.
- **Conversations:** 12.
  - 8 replay real dev Gemini calls from `ordering_call_transcript_segments`. The speech-to-text noise is removed, keeping what the caller meant.
  - 4 are made up, for cases the logged calls don't cover: the "make it 20" correction, a new caller with a new delivery address, two Big Bosses with different omissions, and a transfer request.
- **Gemini baseline:** the order each of those 8 real calls actually produced, graded with the same checks.
- **Models:**
  - `claude-haiku-5-5`: effort low.
  - `claude-sonnet-5-5`: effort low, run twice. First with `thinking: between_tools`, as the brief specified, then with `thinking: adaptive`.
  - All three: streaming, `tool_choice: auto`, prompt caching on tools, system prompt and conversation, no temperature or top_p.

## Accuracy

"Cart right" means the final order's items, sizes, sauces, omissions and quantities match what the caller asked for. "Whole call right" also needs the call to finish correctly: card payment with the right tip, cash close, or transfer.

The new-address conversation is left out. Google couldn't verify "315 Ford Street, Ogdensburg", my test address, so every model was stuck asking for the address again. That's my test data, not the models.

| | Cart right (11) | Whole call right (11) | The 8 replayed Gemini calls: cart right |
|---|---|---|---|
| **Gemini (logged dev calls)** | n/a | n/a | **4/8** |
| Claude Haiku 5.5 | 9/11 (10/11 without a harness bug) | 4/11 | 6/8 (7/8 without the harness bug) |
| Claude Sonnet 5.5, between_tools | 10/11 | 9/11 | 7/8 |
| **Claude Sonnet 5.5, adaptive** | **10/11** | **9/11** | **7/8** |

Gemini missed four orders that both Sonnet runs got right:
- **Turkey Big Boss with no tomato, plus 30 wings as 10 hot and 20 medium:** Gemini said no tomato "isn't an option" and dropped it. It also made 30 medium + 20 hot (50 wings).
- **30 wings as 15 BBQ and 15 medium:** Gemini said "barbecue isn't an option", and the wings never got on the order.
- **Chicken tender dinner with BBQ sauce and coleslaw:** Gemini said BBQ isn't an option, and the dinner never got on the order. Sonnet hit the same coleslaw tool error, then looked it up and fixed it.
- **One pizza, pepperoni with half jalapenos:** Gemini made two pizzas.

Claude's misses:
- **"10 wings, barbecue… Open Pit" (all three Claude runs).**
  - Claude added the wings with plain BBQ before the caller said "Open Pit", then didn't change the sauce.
  - Sonnet also added a separate "4 oz Open Pit BBQ" cup.
  - Gemini asked which BBQ first and got it right.
  - This is a prompt fix: ask which BBQ when the caller says barbecue on wings.
- **Wild West Burger toppings (both Sonnet runs, Haiku too).**
  - The prompt's burger rule asks "anything on that burger?". The caller never answered, and Claude kept asking after every later item, then asked about fries with the burger.
  - The script had no answer, so the call never reached payment. The cart itself was right.
  - Gemini skipped that question on the real call. Claude follows the written rule more literally than Gemini does.
- **Haiku's checkout flow drifted.** It:
  - asked "is that good to send in?" instead of "cash or card",
  - read the order back before the caller was done,
  - asked whether ranch goes on one wing order or both.

  The cart was right in 9 of the 11 graded calls (10 without the harness bug), but the scripted caller fell out of step, so only 4 calls finished. A real caller would cope with some of this. It still means more confused calls than Sonnet.
- The harness bug: a "fries" answer rule fired after "plain fries it is", so a small fry was added that the caller never asked for. That's my test, not Haiku.

**Important:** with `thinking: between_tools`, which is how you turn thinking off on Sonnet 5.5, Sonnet wrote its reasoning into the reply in **24 of 104 turns**. Examples: "The caller moved on without answering the burger question, so I'll…", "The server still shows no tip…". On a phone line that would be read aloud. With `thinking: adaptive` at low effort it happened in **0 of 104 turns**, and that run was also faster and slightly cheaper. Any pilot should use adaptive.

## Speed

Claude is measured from sending the caller's line to the first spoken word (first non-empty text token), streaming, from this server. Gemini is measured from end of caller speech to first audio chunk, from `ordering_ai_call_events`: 644 turns over 64 dev calls.

| | First words p50 | p90 | When a tool runs, p50 | p90 | Whole reply p50 / p90 |
|---|---|---|---|---|---|
| **Gemini Live (voice, end to end)** | **0.75 s** | **1.7 s** | n/a | n/a | n/a |
| Claude Haiku 5.5 (text only) | 2.1 s | 5.1 s | 3.5 s | 5.6 s | 2.2 / 5.2 s |
| Claude Sonnet 5.5, between_tools (text only) | 3.4 s | 4.9 s | 4.2 s | 5.2 s | 4.2 / 6.4 s |
| Claude Sonnet 5.5, adaptive (text only) | 2.7 s | 4.1 s | 3.1 s | 4.2 s | 2.7 / 4.1 s |

Most turns call `price_order`, which means two model requests in a row: the tool call, then the reply. A voice pilot would add speech-to-text end-of-speech detection plus time to first audio from text-to-speech, probably another 0.3 to 0.8 s. So expect about 3 to 5 seconds of silence on most turns, against Gemini's 0.75 to 1.7. Callers will notice that.

## Cost per call

Text only, 12 calls of about 9 turns each. Prices used:
- Haiku 5.5: $0.10 in / $0.50 out per million tokens, cache reads $0.01.
- Sonnet 5.5: $2 in / $10 out per million, cache reads $0.20.

Caching worked: most input tokens on each request were cache reads.

| | Per call |
|---|---|
| Claude Haiku 5.5 | $0.0065 |
| Claude Sonnet 5.5, adaptive | $0.089 |
| Claude Sonnet 5.5, between_tools | $0.095 |
| Gemini 3.1 Live (logged) | $0.23 (only one dev call has a `gemini.callUsage` row, so not a reliable average) |

A voice pilot would add speech-to-text and text-to-speech costs on top of Claude's.

**Spend for this eval:** about $2.29 of the $3 limit. That's the smoke test plus three full runs.

## Recommendation

**Accuracy:** Sonnet 5.5 (adaptive thinking, low effort) is clearly better than the current Gemini line at the hard parts of an order:
- omissions such as no tomato,
- split wing sauces and counts,
- meal sides,
- one pizza versus two.

Haiku is about 14 times cheaper than Sonnet but drifts from the checkout script too much for a phone line as it stands.

**Speed:** this is what decides it. Claude text alone is already slower to first words than Gemini voice end to end.

**A voice pilot (STT + Claude + TTS) is worth building only as a small, dev-only experiment, and only if it includes:**
- Sonnet 5.5 with adaptive thinking at low effort, never `between_tools`;
- streaming text-to-speech that starts on the first sentence;
- a short spoken acknowledgement ("Okay, adding that…") played immediately on turns where a tool runs, so the caller never hears 3 to 5 seconds of silence;
- the two prompt fixes found here: ask which BBQ before adding barbecue wings, and ask about burger toppings once, then move on.

If, after those, the time to first audio isn't under about 1.5 s p50, keep Gemini for the voice. Otherwise, Claude could be added just as a cart checker behind Gemini, with no voice of its own. That would be a separate design.

## Rerun

```
npm run eval:claude-phone -- --gemini-only        # grade the logged Gemini calls, no API key needed
npm run eval:claude-phone -- --dry-run            # check prompt, tools and rollback; no model calls
npm run eval:claude-phone -- --models haiku,sonnet-adaptive [--only key,key] [--budget 3]
```

The key is read from `/opt/corner-ops/config/anthropic-dev.env` (`ANTHROPIC_API_KEY`, mode 600). Raw per-turn results are written to `scripts/claude-phone-eval/results/`, which is git-ignored because it contains caller details.
