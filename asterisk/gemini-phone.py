#!/usr/bin/env python3
"""Asterisk AudioSocket to Gemini Live bridge. Never handles card data."""

import asyncio
import audioop
import base64
import hashlib
import json
import os
import struct
import time
import urllib.request
from urllib.parse import quote

import websockets

APP_URL = os.environ.get("GEMINI_PHONE_APP_URL", "http://127.0.0.1:3000").rstrip("/")
API_KEY = os.environ.get("GEMINI_API_KEY", "")
INTERNAL_SECRET = os.environ.get("VOICE_PAYMENT_INTERNAL_SECRET", "")
MCP_TOKEN = os.environ.get("OPENAI_ORDERING_MCP_TOKEN", "")


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
            return json.loads(content[0]["text"])
        except json.JSONDecodeError:
            return {"text": content[0]["text"]}
    return body


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
    tool_results = {}
    turn_mutation_keys = {}
    user_turn_open = False
    customer_turn_id = 0
    order_mutation_lock = asyncio.Lock()
    async with websockets.connect(url, max_size=None, ping_interval=20) as gemini:
        await gemini.send(
            json.dumps(
                {
                    "setup": {
                        "model": f"models/{model}",
                        "generationConfig": {"responseModalities": ["AUDIO"]},
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
        await gemini.recv()
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
                kind, payload = await read_packet(reader)
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
            async for raw in gemini:
                message = json.loads(raw)
                server = message.get("serverContent", {})
                interrupted = server.get("interrupted") is True
                if interrupted:
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
                    customer_transcript += str(transcription["text"])
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
                        pcm24 = base64.b64decode(inline["data"])
                        pcm8, output_state = audioop.ratecv(
                            pcm24, 2, 1, 24000, 8000, output_state
                        )
                        await playback.enqueue(pcm8)
                if server.get("generationComplete") is True:
                    await playback.generation_complete()
                if server.get("turnComplete") is True:
                    await playback.generation_complete()
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
                    normalized_arguments, tool_call_key = logical_tool_key(
                        customer_turn_id, name, arguments
                    )
                    argument_hash = hashlib.sha256(
                        normalized_arguments.encode()
                    ).hexdigest()
                    is_mutation = name in {
                        "price_order",
                        "submit_order",
                        "modify_order",
                    }
                    prior_mutation_key = turn_mutation_keys.get(customer_turn_id)
                    conflicting_mutation = bool(
                        is_mutation
                        and prior_mutation_key
                        and prior_mutation_key != tool_call_key
                    )
                    duplicate = tool_call_key in tool_results or conflicting_mutation
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
                    if conflicting_mutation:
                        result = {
                            "error": {
                                "code": "DUPLICATE_TOOL_CALL",
                                "message": "Only one order mutation is allowed for this customer turn.",
                                "retryable": False,
                            }
                        }
                    elif duplicate:
                        result = tool_results[tool_call_key]
                    else:
                        async def execute():
                            if name == "request_human_handoff":
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
                                value = await app_action(
                                    call_id,
                                    "payment",
                                    tipCents=arguments.get("tipCents", 0),
                                )
                                close_requested.set()
                                return value
                            if name == "complete_call":
                                await playback.wait_until_complete()
                                value = await app_action(call_id, "complete")
                                close_requested.set()
                                return value
                            return await mcp_call(
                                call_id,
                                name,
                                arguments,
                                f"gemini-{call_id}-{tool_call_key}",
                            )

                        if is_mutation:
                            turn_mutation_keys[customer_turn_id] = tool_call_key
                            async with order_mutation_lock:
                                result = await execute()
                        else:
                            result = await execute()
                        tool_results[tool_call_key] = result
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
                                "rejected_duplicate"
                                if conflicting_mutation
                                else "cached"
                                if duplicate
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
                if responses and not close_requested.is_set():
                    await gemini.send(
                        json.dumps({"toolResponse": {"functionResponses": responses}})
                    )
                    customer_transcript = ""
                if close_requested.is_set():
                    # Release AudioSocket immediately so Asterisk can continue into
                    # payment/handoff without a silent Gemini cleanup delay.
                    writer.close()
                    break

        tasks = [
            asyncio.create_task(caller_audio()),
            asyncio.create_task(model_audio()),
            asyncio.create_task(playback.run()),
        ]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            if not task.cancelled():
                task.result()
        if telemetry_tasks:
            if close_requested.is_set():
                for task in telemetry_tasks:
                    task.cancel()
            else:
                await asyncio.gather(*telemetry_tasks, return_exceptions=True)


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
        print(f"Gemini bridge call failed: {type(error).__name__}", flush=True)
        if call_id:
            try:
                await app_action(call_id, "handoff", reason="Gemini bridge failed.")
            except Exception:
                pass
    finally:
        writer.close()
        await writer.wait_closed()


async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", 9092)
    print("Gemini AudioSocket bridge listening on 127.0.0.1:9092", flush=True)
    async with server:
        await server.serve_forever()


async def self_test():
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
    print(json.dumps({"status": "passed", "frames": len(writer.frames)}))


if __name__ == "__main__":
    import sys

    asyncio.run(self_test() if "--self-test" in sys.argv else main())
