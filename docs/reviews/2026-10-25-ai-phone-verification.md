# AI phone ordering verification (2026-10-25)

Branch `agent/pos-ordering-foundation`. Started from `4e50ae6`. Fixes are in `9d6affe` (phone card payment), `92275af` (cart) and `e4e7dfd` (Gemini bridge). Dev runs `e4e7dfd`. Nothing was deployed to production and `main` was not merged. The handoff files `Corner-Deli-call-fixes.txt` and `Corner-Deli-regression-results.txt` were not on this machine, so the six priorities were taken from the request text.

**What this does not prove.** Every result here comes from automated tests: mocked MX, a fake Gemini socket and DB-level checks. No real phone call, no live Gemini voice and no paper ticket was verified.

## GitHub Verify run 40158914405 (commit 4e50ae6)

- **Result:** failure. The `ai-regressions` job failed and `build` passed.
- **Failing test:** `test:ai-cart-safety`, case "call replay: 30 medium + 20 hot becomes 20 medium + 10 hot atomically".
- **Cause:** the readback order of modifiers was random (defect C11 below). This made the test pass or fail by chance: 4 local runs gave fail, pass, fail, pass. Fixed in `92275af`.

## 1–4. Cart behavior (`92275af`)

**Already correct before the fix:**
- Turkey Big Boss omissions ("no tomato", "without tomatoes", remove).
- Edits keep the line ID, its price and its other modifiers.
- Invalid removals change nothing.
- The 30→20/10 wing batch correction is atomic.
- Explicit, stale, duplicate and ambiguous line IDs are handled correctly.
- An invalid second modifier makes no partial change.
- Fries: nacho cheese and gravy default to the side, "on top" overrides, and a missing size asks a follow-up.

**Defects found and fixed:**

| # | Defect | Fix |
|---|---|---|
| C1 | "tomato" (positive) was saved as **No Tomato** (fuzzy match) | Fuzzy and partial matching never cross no/without polarity |
| C2 | "tomato" / "add the tomato back" could not restore it | `resolveSpokenRecipeRestore` removes the omission |
| C3 | "Xtra Russian" and "No Russian" both stayed on the ticket | No X and Xtra/Add X exclude each other on the same line |
| C4 | Sideband readback groups showed as "undefined" | `group_name_snapshot` added to the SELECT |
| C5 | **"make it 20" on a 30-wing line became 20 × 30 wings ($845)** | On a wing line, a quantity that is a valid wing count becomes the wing count |
| C6 | `remove_item` with two line IDs removed only the first | Removes all of them or none |
| C7 | Gemini (MCP) results had no modifiers or line IDs | `price_order`/`get_draft` lines carry `lineId` and `modifiers` |
| C8 | Asked "blue cheese, ranch, or celery?" again after a flavor change | The check runs on the merged line and accepts "Blue Cheese (4oz)" |
| C9 | A flavor change deleted the "Sweet & Sassy (4oz)" / "Sweet & Sour (4oz)" / "Medium (4oz)" / "Garlic Parmesan (4oz)" cups | Clean-up is limited to the Wing Sauce group |
| C10 | "Make them BBQ sauce" on an edit added a paid cup and left the flavor | Without side/cup/extra words, "<flavor> sauce" means the flavor |
| C11 | Modifier order was random after a reprice | Ordered by print order, group and name |
| F1 | Curly fries, waffle fries and tots ignored "on top" | Placement applies to every fry and tot item |
| F2 | A hot dog's "nacho cheese" became the $1.75 fry cup | The item's own topping is preferred |
| F3 | "nachos" / "chili" with fries in the cart became fry modifiers | A word that names a dish attaches only when it exactly matches a modifier |

**Also fixed:**
- "hold the tomato" now works.
- An edit now accepts "nacho cheese on the fries".
- "fries" on a Large French Fries line keeps the full name.

**Left as is:** "no jalapenos" when jalapenos aren't selected succeeds as a no-op, but still rewrites the draft rows. This is a design call and does no harm.

**Tests:** `scripts/ai-cart-regressions/` (`npm run test:ai-cart-regressions`), 5 suites. Their results on `4e50ae6`, before the fix:

| Suite | Before the fix |
|---|---|
| bigboss | 6 failed |
| wings | 4 failed |
| wing-sauces | 5 failed |
| fries | 5 failed |
| modifier-order | failed |

All pass now. They also passed against a CI-identical database (migrations plus `tests/fixtures/ai-menu.sql.gz`). They run in CI.

## 5. Voice bridge (`e4e7dfd`)

**Verified unchanged:**
- The model is pinned per call (`gemini-2.5-flash-native-audio-latest`, voice Kore).
- The voice config can't be mutated.
- The `sessionConfigured` event is emitted (checked in the offline test).
- Barge-in clears queued audio.
- No live Gemini call has happened since the deploy, so `sessionConfigured` rows from real calls don't exist yet.

**Defects found and fixed:**

| # | Defect | Fix |
|---|---|---|
| V1 | After a failed cart change, the corrected retry was blocked (DUPLICATE_TOOL_CALL) | Failed results are never cached and never block another call |
| V2 | One cart change per caller turn, so "add fries and make the wings hot" lost one change | Different changes in one turn both run |
| V3 | The same request in a later model turn was answered from cache, so nothing was added | A new logical turn starts at each turnComplete |
| V4 | `toolCallCancellation` was ignored | Logged; cancelled calls get no response |
| V5 | A normal Gemini close or goAway silently dropped the caller | The call is handed to an employee |
| V6 | Talking over the goodbye still hung up | The hang-up waits for playback plus 0.8 s and checks for new caller speech |
| V7 | The mutation set listed nonexistent tools and missed `send` | Uses the real tool names |
| V8 | Errors were told "continue checkout", and error messages containing "draft" were dropped | Errors keep their message ("draft" → "order") and get a "fix this first" instruction |
| V9 | Transcript pieces were joined without spaces ("on the"+"fries") | Word breaks are kept |

**Kept:** an identical call, or the same items added again, inside one model turn still runs only once.

**Tests:**
- `asterisk/gemini-phone-bridge-test.py` (fake Gemini Live socket) has 12 checks. Against the old bridge, 9 failed; the 3 that passed check behavior that was meant to be kept.
- It runs in CI after `--self-test`, in `python:3.12-slim`.

**Not done:**
- No server-side idempotency key on MCP calls. The bridge never retries a transport failure, though: a failure hands the call off.
- The model name is the floating `-latest` alias, as requested.

## 6. Phone card payment (`9d6affe`)

**Verified correct before the fix:**
- The kitchen ticket is created exactly once (unique index, `ON CONFLICT` and an atomic claim).
- A duplicate submit and `commitTender` are idempotent.

**Defects found and fixed:**

| Defect | Fix |
|---|---|
| A lost MX reply was retried blindly or abandoned | The payment is looked up by replayId first. Approved → it is applied. Unknown → `needs_review`, no second charge. A real decline → a new replayId for the next card. |
| No send preflight before charging (hours, delivery minimum, ...) | `assertVoiceOrderReady` runs `preflightDraftSubmit` |
| The amount could change between the session start and the charge | Checked before the charge and again after approval. A mismatch is voided at MX. |
| An approved charge that couldn't be recorded wasn't voided | Voided (`approved_unapplied`). If the void fails, it goes to `needs_review`. Both stay on the POS alert list. |
| A send or print failure after the payment was recorded reported the payment as failed | The caller hears "approved". The paid draft stays on the POS alert list. |
| The AGI gave up after 25 s while the server could still be charging | The AGI waits 60 s (server worst case is about 44 s) |
| A second session could start while one was charging | `prepareVoicePayment` refuses it |

**Tests:** `scripts/voice-payment-recovery/` (`npm run test:voice-payment-recovery`), 4 scenarios. All 4 failed before the fix and pass now; they run in CI.

**Updated tests:** `test:ai-payment-safety` and `test:voice-payment` were changed to the new rules. Their MX stub now answers replayId lookups and voids the way the MX sandbox does (verified earlier).

**Still open (not fixed):**
- A hang-up during transfer leaves the call in `handoff_pending`.
- Voice orders are sent whatever the shadow/assisted mode is.
- The delivery fee is recalculated after payment.

**Incident:** the checkout check agent briefly wrote outside its rollback on dev, deactivating printers and hours and deleting the Christmas special-hours row. It restored them, and I verified afterwards: 3 printers active, 7/7 hours windows, the Christmas row present.

## Final local results (e4e7dfd)

**Passed:**
- AI suites: `test:ai-payment-safety`, `test:voice-payment-recovery`, `test:ai-cart-safety`, `test:ai-cart-regressions`, `test:ai-natural-aliases`, `test:ai-followup-modifiers`, `test:ai-phone-conversation`, `test:ai-order-regressions`, `test:ai-ordering`, `test:openai-phone`, `test:gemini-phone-routing`, `test:gemini-phone -- --offline`.
- Payment suites: `test:voice-payment`, `test:payments`, `test:online-checkout-preflight`.
- Python `--self-test` and `gemini-phone-bridge-test.py` (in the CI image).
- `npm test`, typecheck and `npm run build`.

**Dev deploy:**
- Source and runtime SHAs are both `e4e7dfd`.
- `/api/health` is ok.
- Postgres is healthy and 5432 is unpublished.
- The asterisk container runs the new bridge.
