"""Offline regression test for asterisk/gemini-phone.py's call loop (2026-10-25 fixes; each case failed before).

Drives bridge() with a scripted fake Gemini Live socket, fake AudioSocket reader/writer and fake
app/MCP endpoints. No network, no database, no phone call: it proves the bridge's decisions, not
real speech. Run: python3 asterisk/gemini-phone-bridge-test.py asterisk/gemini-phone.py
(needs Python 3.12 for audioop, plus websockets; CI runs it in python:3.12-slim).
"""
import asyncio, importlib.machinery, importlib.util, json, sys, warnings

warnings.filterwarnings("ignore")
path = sys.argv[1] if len(sys.argv) > 1 else "/usr/local/bin/corner-ops-gemini-phone"
gp_name = path
loader = importlib.machinery.SourceFileLoader("gp", path)
spec = importlib.util.spec_from_loader("gp", loader)
gp = importlib.util.module_from_spec(spec)
loader.exec_module(gp)


class FakeGemini:
    def __init__(self, script):
        self.script = list(script)  # server messages (dict) or ("wait_for_tool_response",)
        self.sent = []
        self.inbox = asyncio.Queue()
        self.tool_response_seen = asyncio.Event()

    async def send(self, raw):
        msg = json.loads(raw)
        self.sent.append(msg)
        if "toolResponse" in msg:
            self.tool_response_seen.set()

    async def recv(self):
        return json.dumps({"setupComplete": {}})

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for item in self.script:
            if item == "WAIT_TOOL_RESPONSE":
                await asyncio.wait_for(self.tool_response_seen.wait(), 2)
                self.tool_response_seen.clear()
                continue
            if item == "SLEEP":
                await asyncio.sleep(0.1)
                continue
            yield json.dumps(item)
        # normal close (code 1000), like a GoAway / session-limit close

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class Reader:
    async def readexactly(self, n):
        await asyncio.sleep(3600)


class Writer:
    def __init__(self):
        self.frames = []

    def write(self, v):
        self.frames.append(v)

    async def drain(self):
        pass

    def close(self):
        pass

    async def wait_closed(self):
        pass


async def run(script, mcp_results):
    log = {"mcp": [], "app": [], "events": []}
    fake = FakeGemini(script)
    results = list(mcp_results)

    async def app_session(call_id):
        return {"model": "gemini-2.5-flash-native-audio-latest", "greeting": "hi", "instructions": "x"}

    async def mcp_tools():
        return [{"name": "price_order", "inputSchema": {"type": "object"}}]

    gp.CLOSING_GRACE_SECONDS = 0.05

    async def mcp_call(call_id, name, arguments, request_id=None):
        log["mcp"].append((name, arguments, request_id))
        return gp.voice_safe_tool_result(results.pop(0) if results else {"ok": True})

    async def app_action(call_id, action, **values):
        if action == "event":
            log["events"].append((values["label"], values.get("detail", {})))
        else:
            log["app"].append(action)
        if action == "complete":
            return {"closeBridge": True}
        return {}

    gp.app_session, gp.mcp_tools, gp.mcp_call, gp.app_action = app_session, mcp_tools, mcp_call, app_action
    gp.websockets.connect = lambda *a, **k: fake
    writer = Writer()
    try:
        await asyncio.wait_for(gp.handle_bridge if False else gp.bridge(Reader(), writer, "call-1"), 5)
    except Exception as e:  # noqa
        log["exception"] = type(e).__name__
    await asyncio.sleep(0.05)
    log["toolResponses"] = [m["toolResponse"] for m in fake.sent if "toolResponse" in m]
    return log


def tool_call(cid, args):
    return {"toolCall": {"functionCalls": [{"id": cid, "name": "price_order", "args": args}]}}


def transcript(text):
    return {"serverContent": {"inputTranscription": {"text": text}}}


AUDIO = {"serverContent": {"modelTurn": {"parts": [{"inlineData": {"data": "AAAAAAAAAAA=" * 40}}]}}}
DONE = {"serverContent": {"generationComplete": True, "turnComplete": True}}


def first_result(log, index):
    return log["toolResponses"][index]["functionResponses"][0]["response"]["result"]


async def main():
    checks = []

    def check(name, condition, detail):
        checks.append(name)
        assert condition, f"{name}: {json.dumps(detail, default=str)}"

    # 1. A corrected retry after a validation error in the same caller turn runs (was DUPLICATE_TOOL_CALL).
    log = await run(
        [transcript("I want 30 wings total, 10 hot and 20 medium"),
         tool_call("a", {"operation": "replace_item", "items": [{"name": "Wings", "variant": "20 Wings"}]}),
         "WAIT_TOOL_RESPONSE",
         tool_call("b", {"operation": "replace_item", "items": [{"name": "Wings", "variant": "20 Wings", "lineId": "L1"}, {"name": "Wings", "variant": "10 Wings", "lineId": "L2"}]}),
         "WAIT_TOOL_RESPONSE"],
        [{"error": {"code": "INVALID_INPUT", "message": "Send corrections for the draft with current lineIds."}}],
    )
    check("corrected retry after an error runs", len(log["mcp"]) == 2 and "error" not in first_result(log, 1), log)
    error = first_result(log, 0)["error"]
    check("error message survives the draft-word scrub", "order with current lineIds" in error.get("message", ""), error)
    check("error result is not told to continue checkout", "Continue the customer-facing checkout" not in first_result(log, 0).get("voiceInstruction", ""), first_result(log, 0))

    # 2. The same add in a new model turn is a new request (was answered from cache, nothing added).
    log = await run(
        [transcript("add a large fries"),
         tool_call("a", {"operation": "add", "items": [{"name": "Large French Fries", "quantity": 1}]}),
         "WAIT_TOOL_RESPONSE", AUDIO, DONE, "SLEEP",
         tool_call("b", {"operation": "add", "items": [{"name": "Large French Fries", "quantity": 1}]}),
         "WAIT_TOOL_RESPONSE",
         transcript("and another large fries")],
        [{"ok": True, "lines": ["fries"]}],
    )
    check("identical add in a later model turn runs", len(log["mcp"]) == 2, log["mcp"])

    # 3. A repeated identical call inside one model turn still runs once (duplicate protection kept).
    log = await run(
        [transcript("add a large fries"),
         tool_call("a", {"operation": "add", "items": [{"name": "Large French Fries", "quantity": 1}]}),
         "WAIT_TOOL_RESPONSE",
         tool_call("b", {"operation": "add", "items": [{"name": "large french fries"}]}),
         "WAIT_TOOL_RESPONSE"],
        [{"ok": True}],
    )
    check("re-worded repeat of the same add in one turn runs once", len(log["mcp"]) == 1, log["mcp"])

    # 4. Two different changes in one caller turn both run (was one change per turn).
    log = await run(
        [transcript("add fries and make the wings hot"),
         tool_call("a", {"operation": "add", "items": [{"name": "Large French Fries"}]}),
         "WAIT_TOOL_RESPONSE",
         tool_call("b", {"operation": "replace_item", "targetLineId": "W1", "items": [{"name": "Wings", "modifiers": [{"name": "Hot"}]}]}),
         "WAIT_TOOL_RESPONSE"],
        [{"ok": True}, {"ok": True}],
    )
    check("two different changes in one turn both run", len(log["mcp"]) == 2, log["mcp"])

    # 5. toolCallCancellation is recorded (was ignored silently).
    log = await run(
        [transcript("add a turkey sub"),
         tool_call("a", {"operation": "add", "items": [{"name": "Turkey", "quantity": 1}]}),
         {"toolCallCancellation": {"ids": ["a"]}},
         "WAIT_TOOL_RESPONSE"],
        [{"ok": True}],
    )
    check("tool call cancellation is recorded", any(name == "toolCallCancellation" for name, _ in log["events"]), log["events"])

    # 6. Gemini closing the session mid-order hands the caller to an employee (was a silent drop).
    log = await run([transcript("add a turkey sub"), tool_call("a", {"operation": "add", "items": [{"name": "Turkey"}]}), "WAIT_TOOL_RESPONSE"], [{"ok": True}])
    check("session end mid-order hands off", "handoff" in log["app"] and "complete" not in log["app"], log["app"])
    configured = [detail for name, detail in log["events"] if name == "sessionConfigured"]
    check("sessionConfigured telemetry is sent", len(configured) == 1, configured)

    # 7. A caller who talks over the goodbye is not hung up on (was hung up).
    closing = {"serverContent": {"outputTranscription": {"text": "Your pickup should be ready in 15 minutes. Thanks for calling, see you then!"}, "modelTurn": {"parts": [{"inlineData": {"data": "AAAAAAAAAAA=" * 400}}]}}}
    log = await run([closing, {"serverContent": {"interrupted": True}}, transcript("wait, add a drink"), {"serverContent": {"turnComplete": True}}, "SLEEP", "SLEEP"], [])
    check("interrupted goodbye does not complete the call", "complete" not in log["app"], log["app"])

    # 8. An uninterrupted goodbye still ends the call normally.
    log = await run([closing, {"serverContent": {"generationComplete": True, "turnComplete": True}}, "SLEEP", "SLEEP", "SLEEP"], [])
    check("uninterrupted goodbye completes the call", "complete" in log["app"] and "handoff" not in log["app"], log["app"])

    check("delivery goodbye counts as the closing line", gp.is_closing_line("Your order is in! Give us about 40 to 55 minutes, and we'll get it to you as soon as we can. Thanks for calling!"), {})

    usage = gp.new_usage()
    gp.add_usage(usage, {"promptTokenCount": 1000, "responseTokenCount": 200, "promptTokensDetails": [{"modality": "TEXT", "tokenCount": 800}, {"modality": "AUDIO", "tokenCount": 200}], "responseTokensDetails": [{"modality": "AUDIO", "tokenCount": 200}]})
    summary = gp.usage_summary(usage, "m")
    check("call usage is priced by modality", abs(summary["estimatedCostUsd"] - (800 * 0.75 + 200 * 3 + 200 * 12) / 1e6) < 1e-9, summary)
    check("sliding window is configured", gp.context_window_compression()["slidingWindow"]["targetTokens"] <= gp.context_window_compression()["triggerTokens"], gp.context_window_compression())

    # 9. Transcript pieces are joined with spaces so "on the"+"fries" still reads as a fry topping.
    check("transcript pieces keep word breaks", gp.join_transcript("nacho cheese on the", "fries") == "nacho cheese on the fries", gp.join_transcript("nacho cheese on the", "fries"))
    # 11. An order that isn't ready for the card line (no delivery address) goes back to the model to fix,
    #     instead of killing the call (dev test call 2026-10-25 was dropped into a loop).
    import io, urllib.error

    log = {"app": [], "toolResponses": []}
    fake = FakeGemini([
        transcript("card, three dollar tip"),
        {"toolCall": {"functionCalls": [{"id": "p1", "name": "request_secure_voice_payment", "args": {"tipCents": 300}}]}},
        "WAIT_TOOL_RESPONSE",
    ])

    async def payment_action(call_id, action, **values):
        log["app"].append(action)
        if action == "payment":
            raise urllib.error.HTTPError("http://app", 409, "Conflict", {}, io.BytesIO(b'{"error":"Delivery address is required before checkout."}'))
        return {}

    async def session(call_id):
        return {"model": "gemini-3.1-flash-live-preview", "greeting": "hi", "instructions": "x"}

    async def tools():
        return [{"name": "price_order", "inputSchema": {"type": "object"}}]

    saved = (gp.app_session, gp.mcp_tools, gp.app_action, gp.websockets.connect)
    gp.app_session, gp.mcp_tools, gp.app_action = session, tools, payment_action
    gp.websockets.connect = lambda *a, **k: fake
    try:
        await asyncio.wait_for(gp.bridge(Reader(), Writer(), "call-pay"), 5)
    except Exception as error:
        log["exception"] = type(error).__name__
    finally:
        gp.app_session, gp.mcp_tools, gp.app_action, gp.websockets.connect = saved
    responses = [m["toolResponse"] for m in fake.sent if "toolResponse" in m]
    result = responses[0]["functionResponses"][0]["response"]["result"] if responses else {}
    check(
        "payment not ready returns the reason to the model",
        result.get("error", {}).get("code") == "PAYMENT_NOT_READY" and "deliveryAddress" in result["error"].get("remedy", "") and "exception" not in log,
        {"result": result, "log": log},
    )

    # 14. A stall (Gemini still "hearing" the caller after "delivery", dev call 2026-10-26) gets a nudge.
    gp.STALL_SECONDS = 0.3
    log = await run([transcript("delivery"), {"serverContent": {"interrupted": True}}] + ["SLEEP"] * 10, [])
    check("a silent stall is nudged", any(name == "stallNudge" for name, _ in log["events"]), [name for name, _ in log["events"]][-6:])
    gp.STALL_SECONDS = 8

    # 12. "Um" is not silence: a handoff "because the caller was silent" right after they spoke is refused.
    log = await run(
        [transcript("Um"),
         {"toolCall": {"functionCalls": [{"id": "h1", "name": "request_human_handoff", "args": {"reason": "customer was silent for too long"}}]}},
         "WAIT_TOOL_RESPONSE"],
        [],
    )
    refused = first_result(log, 0) if log["toolResponses"] else {}
    check("silence handoff right after the caller spoke is refused", log["app"].count("handoff") == 1 and refused.get("error", {}).get("code") == "HANDOFF_NOT_NEEDED", {"app": log["app"], "result": refused})
    check("a real request for a person still transfers", gp.silence_handoff_blocked("caller asked for a manager", 1) is False, {})

    # 13. Under the delivery minimum: the model is told to offer adding items or pickup, not to transfer.
    import io, urllib.error
    ready = gp.payment_not_ready(urllib.error.HTTPError("http://app", 409, "Conflict", {}, io.BytesIO(b'{"error":"Delivery minimum is $20.00. Order is $4.25 short. Manager or owner override with a reason is required."}')))
    check("delivery minimum gets an add-or-pickup remedy", "pickup" in ready["error"]["remedy"] and "Do not transfer" in ready["error"]["remedy"] and "Manager" not in ready["error"]["message"], ready)

    # 10. A Gemini error mid-call (e.g. close 1007) transfers the caller at once (was ~20 s of silence).
    import uuid as uuid_module

    class PacketReader:
        def __init__(self):
            self.data = bytes([0x01, 0x00, 0x10]) + uuid_module.uuid4().bytes

        async def readexactly(self, n):
            if not self.data:
                await asyncio.sleep(3600)
            chunk, self.data = self.data[:n], self.data[n:]
            return chunk

    actions = []

    async def failing_bridge(reader, writer, call_id):
        raise RuntimeError("simulated Gemini close 1007")

    async def record_action(call_id, action, **values):
        actions.append(action)
        return {}

    original_bridge, original_action = gp.bridge, gp.app_action
    gp.bridge, gp.app_action = failing_bridge, record_action
    writer = Writer()
    try:
        await asyncio.wait_for(gp.handle(PacketReader(), writer), 5)
    finally:
        gp.bridge, gp.app_action = original_bridge, original_action
    check("bridge failure hands off and releases the call", actions[:1] == ["handoff"] and b"\x00\x00\x00" in writer.frames, {"actions": actions, "frames": [f.hex() for f in writer.frames]})

    # Tool results stay in the Live context and are re-billed each turn (2026-10-28): empty fields, default
    # modifier quantities and raw cents go; ids, display totals, tipCents, false/zero and pizza portions stay.
    cart = gp.voice_safe_tool_result({
        "ok": True, "orderId": "o1", "totalCents": 1599, "totalDisplay": "$15.99", "amountDueCents": 1599,
        "amountDueDisplay": "$15.99", "tipCents": 0, "paymentMethod": "", "warnings": [],
        "lines": [{"say": "Pizza Jumbo Thin with half Mushrooms", "lineId": "L1", "variant": "Jumbo Thin", "quantity": 1,
                   "modifiers": [{"group": "Pizza Toppings", "name": "Mushrooms", "quantity": 1, "portion": "left_half"},
                                 {"group": "Wing Sauce", "name": "Mild", "quantity": 2}]}],
    })
    modifiers = cart["lines"][0]["modifiers"]
    check("compact cart drops raw cents and empty fields", not {"totalCents", "amountDueCents", "paymentMethod", "warnings"} & set(cart), cart)
    check("compact cart keeps ids, totals, tip and quantities", cart["orderId"] == "o1" and cart["totalDisplay"] == "$15.99" and cart["tipCents"] == 0 and cart["lines"][0]["quantity"] == 1 and cart["lines"][0]["lineId"] == "L1", cart)
    check("compact cart keeps portions and non-default modifier quantities", "quantity" not in modifiers[0] and modifiers[0]["portion"] == "left_half" and modifiers[1]["quantity"] == 2, modifiers)
    failed = gp.voice_safe_tool_result({"ok": False, "error": {"code": "ITEM_NOT_ON_MENU", "message": "No match."}, "pending": False})
    check("compact error keeps ok false and the error", failed["ok"] is False and failed["error"]["code"] == "ITEM_NOT_ON_MENU" and failed["pending"] is False, failed)
    usage = gp.new_usage()
    gp.add_usage(usage, {"promptTokenCount": 10, "cachedContentTokenCount": 4, "toolUsePromptTokenCount": 2, "promptTokensDetails": [{"modality": "TEXT", "tokenCount": 10}]})
    summary = gp.usage_summary(usage, "m")
    check("usage summary reports cached and tool-use prompt tokens", summary["cachedTokens"] == 4 and summary["toolUsePromptTokens"] == 2 and summary["messages"] == 1, summary)
    print(json.dumps({"status": "passed", "checks": len(checks)}))


asyncio.run(main())
