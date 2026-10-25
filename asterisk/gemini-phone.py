#!/usr/bin/env python3
"""Asterisk AudioSocket to Gemini Live bridge. Never handles card data."""

import asyncio
import audioop
import base64
import hashlib
import json
import re
import os
import struct
import time
import urllib.error
import urllib.request
from urllib.parse import quote

import websockets

APP_URL = os.environ.get("GEMINI_PHONE_APP_URL", "http://127.0.0.1:3000").rstrip("/")
API_KEY = os.environ.get("GEMINI_API_KEY", "")
INTERNAL_SECRET = os.environ.get("VOICE_PAYMENT_INTERNAL_SECRET", "")
MCP_TOKEN = os.environ.get("OPENAI_ORDERING_MCP_TOKEN", "")
GEMINI_PHONE_VOICE = "Kore"


def speech_generation_config():
    """One fixed speaker configuration for the entire native-audio session."""
    return {
        "responseModalities": ["AUDIO"],
        # English in and out: without it the caller's words were transcribed as German/Korean/Chinese at times.
        "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": GEMINI_PHONE_VOICE}}, "languageCode": "en-US"},
    }


def http_json(url, method="GET", payload=None, token=None):
    headers = {}
    if token:
        headers["authorization"] = f"Bearer {token}"
    else:
        headers["x-voice-payment-secret"] = INTERNAL_SECRET
    data = None
    if payload is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(payload).encode()
    with urllib.request.urlopen(
        urllib.request.Request(url, data=data, headers=headers, method=method),
        timeout=15,
    ) as response:
        return json.loads(response.read() or b"{}")


async def app_session(call_id):
    return await asyncio.to_thread(
        http_json,
        f"{APP_URL}/api/internal/ai-phone?action=session&callId={quote(call_id)}",
    )


async def app_action(call_id, action, **values):
    return await asyncio.to_thread(
        http_json,
        f"{APP_URL}/api/internal/ai-phone",
        "POST",
        {"callId": call_id, "action": action, **values},
    )


async def mcp_tools():
    body = await asyncio.to_thread(
        http_json,
        f"{APP_URL}/api/openai/ordering/mcp",
        "POST",
        {"jsonrpc": "2.0", "id": "tools", "method": "tools/list"},
        MCP_TOKEN,
    )
    return body.get("result", {}).get("tools", [])


async def mcp_call(call_id, name, arguments, request_id=None):
    body = await asyncio.to_thread(
        http_json,
        f"{APP_URL}/api/openai/ordering/mcp",
        "POST",
        {
            "jsonrpc": "2.0",
            "id": request_id or f"gemini-{call_id}-{name}",
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": {**arguments, "callId": call_id},
            },
        },
        MCP_TOKEN,
    )
    result = body.get("result", {})
    content = result.get("content", [])
    if content and content[0].get("text"):
        try:
            return voice_safe_tool_result(json.loads(content[0]["text"]))
        except json.JSONDecodeError:
            return {"text": content[0]["text"]}
    return body


def voice_safe_tool_result(value):
    """Keep operational draft language out of provider-facing tool results."""
    safe = scrub_internal_order_language(value)
    if isinstance(safe, dict):
        if is_failed_tool_result(safe):
            # An error must reach the model intact; "continue checkout" would tell it to ignore the failure.
            safe["voiceInstruction"] = "Do not narrate internal order state. Fix or ask about this before continuing."
        else:
            safe["voiceInstruction"] = "Do not narrate internal order state. Continue the customer-facing checkout sequence only."
    return safe


def is_failed_tool_result(value):
    return isinstance(value, dict) and (
        "error" in value or value.get("ok") is False or value.get("pending") is True
    )


def scrub_internal_order_language(value):
    if isinstance(value, list):
        return [scrub_internal_order_language(item) for item in value]
    if not isinstance(value, dict):
        return value
    safe = {}
    for key, item in value.items():
        if isinstance(item, str) and "draft" in item.lower():
            if key.lower() == "status":
                continue
            if key.lower() in ("message", "instruction", "remedy"):
                # Reword rather than drop: an error without its message leaves the model guessing.
                item = re.sub(r"\bdraft(s?)\b", r"order\1", item, flags=re.IGNORECASE)
        safe[key] = scrub_internal_order_language(item)
    return safe


CLOSING_GRACE_SECONDS = 0.8

MUTATING_TOOLS = {
    "price_order",
    "create_draft",
    "update_draft",
    "attach_delivery_address",
    "send",
}


def add_signature(arguments):
    """Item names of an add, so a re-worded repeat of the same add in one turn isn't applied twice."""
    if arguments.get("operation") != "add":
        return None
    names = sorted(
        " ".join(str(item.get("name", "")).lower().split())
        for item in arguments.get("items") or []
        if isinstance(item, dict)
    )
    return json.dumps(names) if names else None


class ToolCallGate:
    """Duplicate protection for model tool calls.

    A logical turn is the caller's turn plus the model turns inside it: it advances on new caller
    speech and on every model turnComplete, so a later identical request is a new request. Within a
    logical turn an identical call, or an add of the same items, returns the first result instead of
    running twice. A failed call (error / follow-up) changed nothing on the server, so it is never
    cached and never blocks a corrected call. Different changes in one turn ("add fries and make the
    wings hot") both run.
    """

    def __init__(self):
        self.results = {}
        self.added = {}

    def lookup(self, turn_key, name, arguments):
        _, key = logical_tool_key(turn_key, name, arguments)
        if key in self.results:
            return key, self.results[key]
        signature = add_signature(arguments) if name == "price_order" else None
        if signature and (turn_key, signature) in self.added:
            return key, self.added[(turn_key, signature)]
        return key, None

    def record(self, turn_key, name, arguments, result):
        if is_failed_tool_result(result):
            return
        _, key = logical_tool_key(turn_key, name, arguments)
        self.results[key] = result
        signature = add_signature(arguments) if name == "price_order" else None
        if signature:
            self.added[(turn_key, signature)] = result


def payment_not_ready(error):
    try:
        message = str(json.loads(error.read() or b"{}").get("error", ""))
    except Exception:
        message = ""
    message = message or "The order is not ready for card payment."
    if "delivery minimum" in message.lower():
        # e.g. "Delivery minimum is $20.00. Order is $4.25 short." Never a reason to transfer.
        message = re.sub(r"\s*Manager or owner override.*$", "", message)
        remedy = (
            "Do not transfer. Tell the caller the delivery minimum and how much more is needed (from the "
            "message), and ask whether they'd like to add something or switch to pickup. Update the order "
            "with price_order, then call request_secure_voice_payment again."
        )
    elif "delivery address" in message.lower():
        remedy = (
            "Call price_order with serviceType delivery and deliveryAddress set to the address the caller "
            "confirmed (plus deliveryUnit if any), then call request_secure_voice_payment again. "
            "If you don't have the address, ask for it first."
        )
    else:
        remedy = (
            "Fix what the message says with price_order or by asking the caller, then call "
            "request_secure_voice_payment again. If it can't be fixed, call request_human_handoff."
        )
    return {"error": {"code": "PAYMENT_NOT_READY", "message": message, "remedy": remedy}}


SILENCE_HANDOFF = re.compile(r"silen|quiet|no (?:answer|response)|not respond|didn.t respond|unresponsive|wait(?:ed|ing)? (?:too )?long|can.t wait|no reply", re.IGNORECASE)


def silence_handoff_blocked(reason, seconds_since_caller_spoke):
    """A transfer "because the caller went silent" while the caller spoke moments ago is the model
    misreading a pause or an "um"; real requests for a person, complaints etc. are never blocked."""
    return bool(SILENCE_HANDOFF.search(str(reason or ""))) and seconds_since_caller_spoke < 30


def context_window_compression():
    # 16k/8k dropped the start of a 90-second call (the AI asked for name and delivery again); live audio adds
    # ~25 tokens a second each way, so keep several minutes of conversation.
    trigger = int(os.environ.get("GEMINI_CONTEXT_TRIGGER_TOKENS", "40000"))
    target = int(os.environ.get("GEMINI_CONTEXT_TARGET_TOKENS", "24000"))
    return {"triggerTokens": trigger, "slidingWindow": {"targetTokens": min(target, trigger)}}


# USD per 1M tokens (ai.google.dev/gemini-api/docs/pricing, 2026-10-25; Live models).
LIVE_PRICES = {"input": {"TEXT": 0.75, "AUDIO": 3.00}, "output": {"TEXT": 4.50, "AUDIO": 12.00}}


def new_usage():
    return {"messages": 0, "input": {}, "output": {}, "prompt": 0, "response": 0}


def add_usage(usage, metadata):
    """Sum Gemini's per-response usage; tokens by modality price differently."""
    if not isinstance(metadata, dict):
        return
    usage["messages"] += 1
    usage["prompt"] += int(metadata.get("promptTokenCount") or 0)
    usage["response"] += int(metadata.get("responseTokenCount") or 0)
    for side, key in (("input", "promptTokensDetails"), ("output", "responseTokensDetails")):
        for row in metadata.get(key) or []:
            modality = str(row.get("modality") or "TEXT")
            usage[side][modality] = usage[side].get(modality, 0) + int(row.get("tokenCount") or 0)


def usage_summary(usage, model):
    cost = 0.0
    for side in ("input", "output"):
        for modality, tokens in usage[side].items():
            cost += tokens / 1_000_000 * LIVE_PRICES[side].get(modality, LIVE_PRICES[side]["TEXT"])
    return {
        "model": model,
        "promptTokens": usage["prompt"],
        "responseTokens": usage["response"],
        "input": usage["input"],
        "output": usage["output"],
        "estimatedCostUsd": round(cost, 4),
    }


def join_transcript(current, chunk):
    """Gemini sends transcription in pieces, some without a leading space ("on the"+"fries")."""
    chunk = str(chunk)
    if current and chunk and current[-1].isalnum() and chunk[0].isalnum():
        return f"{current} {chunk}"
    return current + chunk


def is_closing_line(text):
    closing = text.lower()
    return ("pickup should be ready" in closing or "40 to 55 minutes" in closing or "forty to fifty-five minutes" in closing) and (
        "thanks for calling" in closing or "see you then" in closing
    )


async def read_packet(reader):
    header = await reader.readexactly(3)
    kind, length = header[0], struct.unpack(">H", header[1:])[0]
    return kind, await reader.readexactly(length)


async def write_audio(writer, pcm):
    for offset in range(0, len(pcm), 320):
        chunk = pcm[offset : offset + 320]
        if chunk:
            writer.write(bytes([0x10]) + struct.pack(">H", len(chunk)) + chunk)
    await writer.drain()


async def terminate_audiosocket(writer):
    """Tell Asterisk the media app is finished, then fully close the TCP stream."""
    try:
        writer.write(b"\x00\x00\x00")
        await writer.drain()
    except (ConnectionError, BrokenPipeError):
        pass
    writer.close()
    try:
        await writer.wait_closed()
    except (ConnectionError, BrokenPipeError):
        pass


class SpeechOutput:
    """Owns the single paced AudioSocket playback stream for one Gemini call."""

    def __init__(self, writer, emit):
        self.writer = writer
        self.emit = emit
        self.queue = asyncio.Queue()
        self.turn_id = 0
        self.generation_id = 0
        self.active_generation_id = None
        self.active_playback_id = None
        self.cancelled_generations = set()
        self.assistant_speaking = False
        self.state = "LISTENING"
        self.buffered_ms = 0
        self.sequence = 0
        self.generations = {}

    def _new_lifecycle(self, generation_id):
        return {
            "generationId": generation_id,
            "playbackId": generation_id,
            "generationStarted": True,
            "generationCompleted": False,
            "playbackStarted": False,
            "playbackCompleted": False,
            "canceled": False,
            "bufferedChunks": 0,
            "underrunLogged": False,
            "completeEvent": asyncio.Event(),
        }

    async def begin_generation(self):
        if self.active_generation_id is not None:
            lifecycle = self.generations[self.active_generation_id]
            if not lifecycle["generationCompleted"]:
                return self.active_generation_id
            if not lifecycle["playbackCompleted"] and not lifecycle["canceled"]:
                await lifecycle["completeEvent"].wait()
        self.turn_id += 1
        self.generation_id += 1
        self.active_generation_id = self.generation_id
        self.generations[self.generation_id] = self._new_lifecycle(
            self.generation_id
        )
        self.state = "ASSISTANT_GENERATING"
        await self.emit("generationStart", self.snapshot())
        return self.active_generation_id

    async def enqueue(self, pcm):
        generation_id = await self.begin_generation()
        if generation_id in self.cancelled_generations:
            return
        lifecycle = self.generations[generation_id]
        if lifecycle["generationCompleted"] or lifecycle["playbackCompleted"]:
            return
        for offset in range(0, len(pcm), 320):
            chunk = pcm[offset : offset + 320]
            if not chunk:
                continue
            self.sequence += 1
            self.buffered_ms += 20
            lifecycle["bufferedChunks"] += 1
            lifecycle["underrunLogged"] = False
            if lifecycle["bufferedChunks"] == 1 and not lifecycle["playbackStarted"]:
                await self.emit("firstAudioChunk", self.snapshot())
            await self.queue.put((generation_id, self.sequence, chunk))

    async def run(self):
        while True:
            generation_id, sequence, chunk = await self.queue.get()
            try:
                if generation_id in self.cancelled_generations:
                    continue
                lifecycle = self.generations[generation_id]
                if lifecycle["playbackCompleted"] or lifecycle["canceled"]:
                    continue
                if not lifecycle["playbackStarted"]:
                    lifecycle["playbackStarted"] = True
                    self.assistant_speaking = True
                    self.active_playback_id = generation_id
                    self.state = "ASSISTANT_SPEAKING"
                    await self.emit(
                        "playbackStart",
                        {**self.snapshot(), "eventReason": "first_frame"},
                    )
                self.writer.write(
                    bytes([0x10]) + struct.pack(">H", len(chunk)) + chunk
                )
                await self.writer.drain()
                await asyncio.sleep(0.02)
            finally:
                self.buffered_ms = max(0, self.buffered_ms - 20)
                lifecycle = self.generations.get(generation_id)
                if lifecycle:
                    lifecycle["bufferedChunks"] = max(
                        0, lifecycle["bufferedChunks"] - 1
                    )
                self.queue.task_done()
            await self._finish_if_ready(generation_id)

    async def _finish_if_ready(self, generation_id):
        lifecycle = self.generations.get(generation_id)
        if not lifecycle or lifecycle["playbackCompleted"] or lifecycle["canceled"]:
            return
        if lifecycle["bufferedChunks"]:
            return
        if not lifecycle["generationCompleted"]:
            if lifecycle["playbackStarted"] and not lifecycle["underrunLogged"]:
                lifecycle["underrunLogged"] = True
                await self.emit(
                    "bufferUnderrun",
                    {**self.snapshot(), "eventReason": "waiting_for_more_audio"},
                )
            return
        if not lifecycle["playbackStarted"]:
            lifecycle["playbackCompleted"] = True
            lifecycle["completeEvent"].set()
            if self.active_generation_id == generation_id:
                self.active_generation_id = None
            self.state = "LISTENING"
            return
        lifecycle["playbackCompleted"] = True
        self.assistant_speaking = False
        self.active_playback_id = None
        if self.active_generation_id == generation_id:
            self.active_generation_id = None
        self.state = "LISTENING"
        lifecycle["completeEvent"].set()
        await self.emit(
            "playbackComplete",
            {
                **self.snapshot(generation_id),
                "eventReason": "generation_complete_and_buffer_drained",
            },
        )

    async def generation_complete(self):
        generation_id = self.active_generation_id
        if generation_id is None:
            return
        lifecycle = self.generations[generation_id]
        if lifecycle["generationCompleted"] or lifecycle["canceled"]:
            return
        lifecycle["generationCompleted"] = True
        await self.emit(
            "generationComplete",
            {**self.snapshot(generation_id), "eventReason": "server_event"},
        )
        await self._finish_if_ready(generation_id)

    async def interrupt(self, reason="gemini_interrupted"):
        generation_id = self.active_generation_id or self.active_playback_id
        self.state = "INTERRUPTING"
        if generation_id is not None:
            self.cancelled_generations.add(generation_id)
            lifecycle = self.generations.get(generation_id)
            if lifecycle:
                lifecycle["canceled"] = True
        discarded = 0
        while True:
            try:
                queued_generation, _, _ = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if queued_generation == generation_id:
                discarded += 1
                self.buffered_ms = max(0, self.buffered_ms - 20)
                queued_lifecycle = self.generations.get(queued_generation)
                if queued_lifecycle:
                    queued_lifecycle["bufferedChunks"] = max(
                        0, queued_lifecycle["bufferedChunks"] - 1
                    )
            self.queue.task_done()
        self.active_generation_id = None
        self.active_playback_id = None
        self.assistant_speaking = False
        self.state = "USER_SPEAKING"
        if generation_id is not None and self.generations.get(generation_id):
            self.generations[generation_id]["completeEvent"].set()
        await self.emit(
            "playbackStopped",
            {**self.snapshot(), "reason": reason, "discardedChunks": discarded},
        )

    async def drain(self):
        await self.queue.join()

    async def wait_until_complete(self):
        generation_id = self.active_generation_id or self.active_playback_id
        if generation_id is None:
            return
        await self.generations[generation_id]["completeEvent"].wait()

    def snapshot(self, generation_id=None):
        generation_id = generation_id or self.active_generation_id or self.active_playback_id
        lifecycle = self.generations.get(generation_id, {})
        return {
            "turnId": self.turn_id,
            "generationId": generation_id,
            "playbackId": (
                lifecycle.get("playbackId")
                if generation_id is not None and lifecycle.get("playbackStarted")
                else self.active_playback_id
            ),
            "generationStarted": bool(lifecycle.get("generationStarted")),
            "generationCompleted": bool(lifecycle.get("generationCompleted")),
            "playbackStarted": bool(lifecycle.get("playbackStarted")),
            "playbackCompleted": bool(lifecycle.get("playbackCompleted")),
            "canceled": bool(lifecycle.get("canceled")),
            "assistantSpeaking": self.assistant_speaking,
            "bufferedAudioMs": self.buffered_ms,
            "queuedChunkCount": self.queue.qsize(),
            "audioDevicePlaying": self.assistant_speaking,
            "state": self.state,
        }


def gemini_schema(value):
    """Keep the JSON Schema subset accepted by Gemini function declarations."""
    if isinstance(value, list):
        return [gemini_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {
        key: gemini_schema(item)
        for key, item in value.items()
        if key not in ("$schema", "additionalProperties")
    }


def logical_tool_key(turn_id, name, arguments):
    hash_arguments = {
        key: value for key, value in arguments.items() if key != "customerText"
    }
    normalized = json.dumps(hash_arguments, sort_keys=True, separators=(",", ":"))
    return normalized, hashlib.sha256(
        f"{turn_id}:{name}:{normalized}".encode()
    ).hexdigest()


def declarations(tools):
    rows = [
        {
            "name": row["name"],
            "description": row.get("description", ""),
            "parameters": gemini_schema(
                row.get("inputSchema", {"type": "object"})
            ),
        }
        for row in tools
        if row.get("name") not in ("request_human_handoff",)
    ]
    rows.extend(
        [
            {
                "name": "request_human_handoff",
                "description": "Transfer the caller to a Corner Deli employee.",
                "parameters": {
                    "type": "object",
                    "properties": {"reason": {"type": "string"}},
                    "required": ["reason"],
                },
            },
            {
                "name": "request_secure_voice_payment",
                "description": "Leave AI and start isolated card collection after a confirmed card order.",
                "parameters": {
                    "type": "object",
                    "properties": {"tipCents": {"type": "integer"}},
                    "required": ["tipCents"],
                },
            },
            {
                "name": "complete_call",
                "description": "End the call only after the complete closing sentence has played.",
                "parameters": {"type": "object", "properties": {}},
            },
        ]
    )
    return rows


async def bridge(reader, writer, call_id):
    session = await app_session(call_id)
    tools = await mcp_tools()
    model = session["model"].replace("models/", "")
    url = (
        "wss://generativelanguage.googleapis.com/ws/"
        "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
        f"?key={API_KEY}"
    )
    close_requested = asyncio.Event()
    output_state = None
    input_state = None
    assistant_transcript = ""
    telemetry_tasks = set()
    event_sequence = 0

    async def emit(event_type, detail=None, duration_ms=None):
        nonlocal event_sequence
        event_sequence += 1
        payload = detail or {}
        print(
            json.dumps(
                {"callId": call_id, "event": event_type, **payload},
                separators=(",", ":"),
            ),
            flush=True,
        )
        task = asyncio.create_task(
            app_action(
                call_id,
                "event",
                eventType=f"gemini.{event_type}",
                eventKey=f"{call_id}:gemini:{event_sequence}:{event_type}",
                label=event_type,
                detail=payload,
                durationMs=duration_ms,
            )
        )
        telemetry_tasks.add(task)
        def telemetry_done(done):
            telemetry_tasks.discard(done)
            try:
                done.result()
            except Exception as error:
                print(
                    json.dumps(
                        {
                            "callId": call_id,
                            "event": "telemetryError",
                            "error": type(error).__name__,
                        }
                    ),
                    flush=True,
                )

        task.add_done_callback(telemetry_done)

    playback = SpeechOutput(writer, emit)
    customer_transcript = ""
    tool_gate = ToolCallGate()
    call_usage = new_usage()
    last_customer_speech = time.monotonic()
    closing_tasks = set()
    model_turns = 0
    closing_interrupted = False
    cancelled_tool_calls = set()
    user_turn_open = False
    customer_turn_id = 0
    order_mutation_lock = asyncio.Lock()

    async def save_transcript(speaker, text, turn_id):
        value = " ".join(str(text or "").split()).strip()
        if not value:
            return
        await app_action(
            call_id,
            "transcript",
            speaker=speaker,
            transcript=value,
            turnId=turn_id,
            eventKey=f"{call_id}:gemini:transcript:{speaker}:{turn_id}",
        )

    async def flush_customer_transcript():
        nonlocal customer_transcript
        value = customer_transcript
        customer_transcript = ""
        if value.strip():
            await save_transcript("customer", value, customer_turn_id)

    async def flush_assistant_transcript():
        nonlocal assistant_transcript
        value = assistant_transcript
        assistant_transcript = ""
        if value.strip():
            await save_transcript("assistant", value, playback.turn_id)

    async with websockets.connect(url, max_size=None, ping_interval=20) as gemini:
        await gemini.send(
            json.dumps(
                {
                    "setup": {
                        "model": f"models/{model}",
                        "generationConfig": speech_generation_config(),
                        "realtimeInputConfig": {
                            "automaticActivityDetection": {
                                "disabled": False,
                                "startOfSpeechSensitivity": "START_SENSITIVITY_LOW",
                                "endOfSpeechSensitivity": "END_SENSITIVITY_LOW",
                                "prefixPaddingMs": 40,
                                "silenceDurationMs": 350,
                            },
                            "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
                        },
                        "inputAudioTranscription": {},
                        # The cart lives in the ordering system, so old conversation can go: once the context
                        # passes the trigger, Gemini keeps only the most recent part (cost per turn stays flat).
                        "contextWindowCompression": context_window_compression(),
                        "outputAudioTranscription": {},
                        "systemInstruction": {
                            "parts": [{"text": session["instructions"]}]
                        },
                        "tools": [
                            {"functionDeclarations": declarations(tools)}
                        ],
                    }
                }
            )
        )
        setup_ack = json.loads(await gemini.recv())
        if "setupComplete" not in setup_ack:
            raise RuntimeError("Gemini did not confirm the pinned voice session")
        await emit("sessionConfigured", {"provider": "gemini", "model": model, "voice": GEMINI_PHONE_VOICE})
        await gemini.send(
            json.dumps(
                {
                    "clientContent": {
                        "turns": [
                            {
                                "role": "user",
                                "parts": [
                                    {
                                        "text": f'Say exactly: "{session["greeting"]}"'
                                    }
                                ],
                            }
                        ],
                        "turnComplete": True,
                    }
                }
            )
        )

        async def caller_audio():
            nonlocal input_state
            while not close_requested.is_set():
                try:
                    kind, payload = await read_packet(reader)
                except (asyncio.IncompleteReadError, ConnectionError):
                    if close_requested.is_set():
                        return
                    raise
                if kind == 0x00:
                    break
                if kind == 0x10 and payload:
                    pcm16, input_state = audioop.ratecv(
                        payload, 2, 1, 8000, 16000, input_state
                    )
                    await gemini.send(
                        json.dumps(
                            {
                                "realtimeInput": {
                                    "audio": {
                                        "data": base64.b64encode(pcm16).decode(),
                                        "mimeType": "audio/pcm;rate=16000",
                                    }
                                }
                            }
                        )
                    )

        async def model_audio():
            nonlocal output_state, customer_transcript, user_turn_open
            nonlocal customer_turn_id
            nonlocal assistant_transcript, model_turns, closing_interrupted, last_customer_speech
            async for raw in gemini:
                message = json.loads(raw)
                add_usage(call_usage, message.get("usageMetadata"))
                server = message.get("serverContent", {})
                interrupted = server.get("interrupted") is True
                if message.get("goAway") is not None:
                    await emit("goAway", {**playback.snapshot(), "timeLeft": message["goAway"].get("timeLeft")})
                cancellation = message.get("toolCallCancellation", {})
                if cancellation.get("ids"):
                    # Calls run before the next message is read, so a cancelled call has usually already
                    # finished; its result stays in the cart and the next price_order/get_draft shows it.
                    cancelled_tool_calls.update(str(value) for value in cancellation["ids"])
                    await emit("toolCallCancellation", {**playback.snapshot(), "ids": cancellation["ids"]})
                if interrupted:
                    closing_interrupted = True
                    if not user_turn_open:
                        user_turn_open = True
                        customer_turn_id += 1
                        await emit("userSpeechStart", playback.snapshot())
                    await emit("interrupted", playback.snapshot())
                    await playback.interrupt()
                transcription = server.get("inputTranscription", {})
                if transcription.get("text"):
                    if not user_turn_open:
                        user_turn_open = True
                        customer_turn_id += 1
                        await emit("userSpeechStart", playback.snapshot())
                    customer_transcript = join_transcript(customer_transcript, transcription["text"])
                    last_customer_speech = time.monotonic()
                output_transcription = server.get("outputTranscription", {})
                if output_transcription.get("text"):
                    assistant_transcript = join_transcript(assistant_transcript, output_transcription["text"])
                for part in (
                    []
                    if interrupted
                    else server.get("modelTurn", {}).get("parts", [])
                ):
                    inline = part.get("inlineData", {})
                    if inline.get("data"):
                        if user_turn_open:
                            user_turn_open = False
                            await emit("userSpeechEnd", playback.snapshot())
                            await flush_customer_transcript()
                        pcm24 = base64.b64decode(inline["data"])
                        pcm8, output_state = audioop.ratecv(
                            pcm24, 2, 1, 24000, 8000, output_state
                        )
                        await playback.enqueue(pcm8)
                if server.get("generationComplete") is True:
                    await playback.generation_complete()
                if server.get("turnComplete") is True:
                    await playback.generation_complete()
                    closing = assistant_transcript
                    was_interrupted = closing_interrupted
                    closing_interrupted = False
                    model_turns += 1
                    await flush_assistant_transcript()
                    if is_closing_line(closing) and not was_interrupted:
                        closing_turn = customer_turn_id

                        async def finish_call():
                            await playback.wait_until_complete()
                            await asyncio.sleep(CLOSING_GRACE_SECONDS)
                            # A caller who talks over the goodbye ("wait, add a drink") stays on the line;
                            # keep reading Gemini meanwhile so that speech is noticed.
                            if customer_turn_id != closing_turn or user_turn_open:
                                await emit("closingInterrupted", playback.snapshot())
                                return
                            value = await app_action(call_id, "complete")
                            if value.get("closeBridge"):
                                close_requested.set()
                                await terminate_audiosocket(writer)

                        closing_tasks.add(asyncio.create_task(finish_call()))
                tool_call = message.get("toolCall", {})
                responses = []
                if tool_call.get("functionCalls") and user_turn_open:
                    user_turn_open = False
                    await emit("userSpeechEnd", playback.snapshot())
                for call in tool_call.get("functionCalls", []):
                    name = call.get("name", "")
                    arguments = dict(call.get("args", {}))
                    function_call_id = str(
                        call.get("id") or f"{playback.turn_id}:{name}"
                    )
                    if name == "price_order" and customer_transcript.strip():
                        arguments["customerText"] = customer_transcript.strip()
                    turn_key = f"{customer_turn_id}.{model_turns}"
                    normalized_arguments, _ = logical_tool_key(
                        turn_key, name, arguments
                    )
                    argument_hash = hashlib.sha256(
                        normalized_arguments.encode()
                    ).hexdigest()
                    is_mutation = name in MUTATING_TOOLS
                    tool_call_key, cached_result = tool_gate.lookup(
                        turn_key, name, arguments
                    )
                    duplicate = cached_result is not None
                    if name != "complete_call" and (
                        playback.active_generation_id is not None
                        or playback.active_playback_id is not None
                    ):
                        await playback.interrupt(
                            "tool_execution_replaces_unresolved_audio"
                        )
                    playback.state = "TOOL_EXECUTING"
                    await emit(
                        "toolCallStart",
                        {
                            **playback.snapshot(),
                            "toolInvocationId": function_call_id,
                            "customerTurnId": customer_turn_id,
                            "tool": name,
                            "argumentHash": argument_hash,
                            "retryCount": 0,
                            "isDuplicate": duplicate,
                        },
                    )
                    tool_started = time.monotonic()
                    if duplicate:
                        result = cached_result
                    else:
                        async def execute():
                            if name == "request_human_handoff":
                                if silence_handoff_blocked(arguments.get("reason", ""), time.monotonic() - last_customer_speech):
                                    # "Um" is not silence (dev test call 2026-10-25 was transferred 2 s after "Um").
                                    return {
                                        "error": {
                                            "code": "HANDOFF_NOT_NEEDED",
                                            "message": "The caller is still on the line and just spoke.",
                                            "remedy": "Do not transfer. Say something short like: Take your time, what can I get for you? Then wait.",
                                        }
                                    }
                                value = await app_action(
                                    call_id,
                                    "handoff",
                                    reason=arguments.get(
                                        "reason", "Employee requested."
                                    ),
                                )
                                if value.get("closeBridge"):
                                    close_requested.set()
                                return value
                            if name == "request_secure_voice_payment":
                                try:
                                    value = await app_action(
                                        call_id,
                                        "payment",
                                        tipCents=arguments.get("tipCents", 0),
                                    )
                                except urllib.error.HTTPError as error:
                                    # The order isn't ready for the card line (e.g. no delivery address on it):
                                    # tell the model so it can fix it, instead of dropping the call.
                                    return payment_not_ready(error)
                                close_requested.set()
                                return value
                            if name == "complete_call":
                                await playback.wait_until_complete()
                                value = await app_action(call_id, "complete")
                                if value.get("closeBridge"):
                                    close_requested.set()
                                return value
                            return await mcp_call(
                                call_id,
                                name,
                                arguments,
                                f"gemini-{call_id}-{tool_call_key}",
                            )

                        if is_mutation:
                            async with order_mutation_lock:
                                result = await execute()
                        else:
                            result = await execute()
                        tool_gate.record(turn_key, name, arguments, result)
                    await emit(
                        "toolCallEnd",
                        {
                            **playback.snapshot(),
                            "toolInvocationId": function_call_id,
                            "customerTurnId": customer_turn_id,
                            "tool": name,
                            "argumentHash": argument_hash,
                            "retryCount": 0,
                            "isDuplicate": duplicate,
                            "result": (
                                "cached"
                                if duplicate
                                else "failed"
                                if is_failed_tool_result(result)
                                else "completed"
                            ),
                        },
                        (time.monotonic() - tool_started) * 1000,
                    )
                    if not close_requested.is_set():
                        playback.state = "PROCESSING"
                    responses.append(
                        {
                            "id": call.get("id"),
                            "name": name,
                            "response": {"result": result},
                        }
                    )
                # Gemini cancelled these (the caller spoke over them); it no longer waits for an answer.
                responses = [
                    row for row in responses if str(row.get("id")) not in cancelled_tool_calls
                ]
                if responses and not close_requested.is_set():
                    await gemini.send(
                        json.dumps({"toolResponse": {"functionResponses": responses}})
                    )
                    await flush_customer_transcript()
                if close_requested.is_set():
                    # Release AudioSocket immediately so Asterisk can continue into
                    # payment/handoff without a silent Gemini cleanup delay.
                    await terminate_audiosocket(writer)
                    break
            if not close_requested.is_set():
                # Gemini ended the session (normal close or goAway) while the caller is still on the
                # line: hand the call to an employee instead of dropping it.
                await emit("geminiSessionEnded", playback.snapshot())
                value = await app_action(call_id, "handoff", reason="Gemini session ended.")
                close_requested.set()
                if value.get("closeBridge", True):
                    await terminate_audiosocket(writer)

        tasks = [
            asyncio.create_task(caller_audio()),
            asyncio.create_task(model_audio()),
            asyncio.create_task(playback.run()),
        ]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in [*pending, *closing_tasks]:
            task.cancel()
        for task in done:
            if not task.cancelled():
                task.result()
        if call_usage["messages"]:
            await emit("callUsage", usage_summary(call_usage, model))
        if telemetry_tasks:
            if close_requested.is_set():
                for task in telemetry_tasks:
                    task.cancel()
            else:
                await asyncio.gather(*telemetry_tasks, return_exceptions=True)
        # Preserve a final partial utterance if the caller disconnects before
        # Gemini emits another model turn or tool call.
        await flush_customer_transcript()
        await flush_assistant_transcript()


async def handle(reader, writer):
    call_id = ""
    try:
        kind, payload = await read_packet(reader)
        if kind != 0x01 or len(payload) != 16:
            return
        import uuid

        call_id = str(uuid.UUID(bytes=payload))
        await bridge(reader, writer, call_id)
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    except Exception as error:
        # Close code/reason only (e.g. 1007 from Gemini); never message content.
        closed = getattr(error, "rcvd", None)
        detail = f" code={closed.code} reason={str(closed.reason)[:160]}" if closed is not None else ""
        print(f"Gemini bridge call failed: {type(error).__name__}{detail}", flush=True)
        if call_id:
            try:
                await app_action(call_id, "handoff", reason="Gemini bridge failed.")
            except Exception:
                pass
            # Tell Asterisk the media app is done so the dialplan transfers the caller to an employee
            # right away; a plain socket close left the caller in silence until they hung up.
            await terminate_audiosocket(writer)
    finally:
        if call_id:
            try:
                # This is a no-op after payment or human handoff. The backend
                # ends only calls that are still owned by the AI.
                await app_action(call_id, "disconnect")
            except Exception:
                pass
        writer.close()
        await writer.wait_closed()


async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", 9092)
    print("Gemini AudioSocket bridge listening on 127.0.0.1:9092", flush=True)
    async with server:
        await server.serve_forever()


async def self_test():
    config = speech_generation_config()
    assert config["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Kore"
    config["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] = "test-mutation"
    assert speech_generation_config()["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Kore"
    class Writer:
        def __init__(self):
            self.frames = []

        def write(self, value):
            self.frames.append(value)

        async def drain(self):
            pass

    events = []

    async def emit(name, detail=None, duration_ms=None):
        events.append((name, detail or {}))

    writer = Writer()
    output = SpeechOutput(writer, emit)
    worker = asyncio.create_task(output.run())
    await output.enqueue(bytes(320))
    await output.drain()
    await asyncio.sleep(0.05)
    assert [name for name, _ in events].count("playbackStart") == 1
    assert [name for name, _ in events].count("playbackComplete") == 0
    assert output.assistant_speaking is True
    assert output.state == "ASSISTANT_SPEAKING"
    await output.enqueue(bytes(320))
    await output.drain()
    assert [name for name, _ in events].count("playbackStart") == 1
    assert [name for name, _ in events].count("playbackComplete") == 0
    await output.generation_complete()
    await output.wait_until_complete()
    assert [name for name, _ in events].count("playbackComplete") == 1
    _, first_key = logical_tool_key(
        7,
        "price_order",
        {"operation": "add", "items": [{"name": "Fries"}], "customerText": "fries"},
    )
    _, duplicate_key = logical_tool_key(
        7,
        "price_order",
        {"items": [{"name": "Fries"}], "operation": "add"},
    )
    _, next_turn_key = logical_tool_key(
        8,
        "price_order",
        {"items": [{"name": "Fries"}], "operation": "add"},
    )
    assert first_key == duplicate_key
    assert first_key != next_turn_key
    assert output.assistant_speaking is False
    assert output.state == "LISTENING"
    await output.enqueue(bytes(960))
    interrupted_generation = output.active_generation_id
    await output.interrupt("test_barge_in")
    await output.drain()
    assert interrupted_generation in output.cancelled_generations
    assert output.buffered_ms == 0
    assert len(writer.frames) == 2
    assert [name for name, _ in events].count("playbackStart") == 1
    assert [name for name, _ in events].count("playbackComplete") == 1
    worker.cancel()
    await asyncio.gather(worker, return_exceptions=True)
    print(json.dumps({"status": "passed", "frames": len(writer.frames), "voice": GEMINI_PHONE_VOICE, "sessionVoicePinned": True}))


if __name__ == "__main__":
    import sys

    asyncio.run(self_test() if "--self-test" in sys.argv else main())
