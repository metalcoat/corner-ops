#!/usr/bin/env python3
"""Asterisk AudioSocket to Gemini Live bridge. Never handles card data."""

import asyncio
import audioop
import base64
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
        self.first_chunk_generations = set()

    async def begin_generation(self):
        if self.active_generation_id is None:
            self.turn_id += 1
            self.generation_id += 1
            self.active_generation_id = self.generation_id
            self.state = "ASSISTANT_GENERATING"
            await self.emit("generationStart", self.snapshot())
        return self.active_generation_id

    async def enqueue(self, pcm):
        generation_id = await self.begin_generation()
        if generation_id in self.cancelled_generations:
            return
        for offset in range(0, len(pcm), 320):
            chunk = pcm[offset : offset + 320]
            if not chunk:
                continue
            self.sequence += 1
            self.buffered_ms += 20
            await self.queue.put((generation_id, self.sequence, chunk))
            if generation_id not in self.first_chunk_generations:
                self.first_chunk_generations.add(generation_id)
                await self.emit("firstAudioChunk", self.snapshot())

    async def run(self):
        while True:
            generation_id, sequence, chunk = await self.queue.get()
            try:
                if generation_id in self.cancelled_generations:
                    continue
                if not self.assistant_speaking:
                    self.assistant_speaking = True
                    self.active_playback_id = generation_id
                    self.state = "ASSISTANT_SPEAKING"
                    await self.emit("playbackStart", self.snapshot())
                self.writer.write(
                    bytes([0x10]) + struct.pack(">H", len(chunk)) + chunk
                )
                await self.writer.drain()
                await asyncio.sleep(0.02)
            finally:
                self.buffered_ms = max(0, self.buffered_ms - 20)
                self.queue.task_done()
            if self.queue.empty() and self.assistant_speaking:
                self.assistant_speaking = False
                self.active_playback_id = None
                if self.active_generation_id is None:
                    self.state = "LISTENING"
                await self.emit("playbackComplete", self.snapshot())

    async def generation_complete(self):
        generation_id = self.active_generation_id
        if generation_id is None:
            return
        self.active_generation_id = None
        await self.emit(
            "generationComplete", {**self.snapshot(), "generationId": generation_id}
        )

    async def interrupt(self, reason="gemini_interrupted"):
        generation_id = self.active_generation_id or self.active_playback_id
        self.state = "INTERRUPTING"
        if generation_id is not None:
            self.cancelled_generations.add(generation_id)
        discarded = 0
        while True:
            try:
                queued_generation, _, _ = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if queued_generation == generation_id:
                discarded += 1
                self.buffered_ms = max(0, self.buffered_ms - 20)
            self.queue.task_done()
        self.active_generation_id = None
        self.active_playback_id = None
        self.assistant_speaking = False
        self.state = "USER_SPEAKING"
        await self.emit(
            "playbackStopped",
            {**self.snapshot(), "reason": reason, "discardedChunks": discarded},
        )

    async def drain(self):
        await self.queue.join()

    def snapshot(self):
        return {
            "turnId": self.turn_id,
            "generationId": self.active_generation_id,
            "playbackId": self.active_playback_id,
            "assistantSpeaking": self.assistant_speaking,
            "bufferedAudioMs": self.buffered_ms,
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
    user_turn_open = False
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
            async for raw in gemini:
                message = json.loads(raw)
                server = message.get("serverContent", {})
                interrupted = server.get("interrupted") is True
                if interrupted:
                    if not user_turn_open:
                        user_turn_open = True
                        await emit("userSpeechStart", playback.snapshot())
                    await emit("interrupted", playback.snapshot())
                    await playback.interrupt()
                transcription = server.get("inputTranscription", {})
                if transcription.get("text"):
                    if not user_turn_open:
                        user_turn_open = True
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
                for call in tool_call.get("functionCalls", []):
                    name = call.get("name", "")
                    arguments = dict(call.get("args", {}))
                    function_call_id = str(
                        call.get("id") or f"{playback.turn_id}:{name}"
                    )
                    if name == "price_order" and customer_transcript.strip():
                        arguments["customerText"] = customer_transcript.strip()
                    await emit(
                        "toolCallStart",
                        {**playback.snapshot(), "tool": name},
                    )
                    tool_started = time.monotonic()
                    if function_call_id in tool_results:
                        result = tool_results[function_call_id]
                    elif name == "request_human_handoff":
                        result = await app_action(
                            call_id,
                            "handoff",
                            reason=arguments.get("reason", "Employee requested."),
                        )
                        close_requested.set()
                    elif name == "request_secure_voice_payment":
                        result = await app_action(
                            call_id,
                            "payment",
                            tipCents=arguments.get("tipCents", 0),
                        )
                        close_requested.set()
                    elif name == "complete_call":
                        await playback.drain()
                        result = await app_action(call_id, "complete")
                        close_requested.set()
                    else:
                        result = await mcp_call(
                            call_id,
                            name,
                            arguments,
                            f"gemini-{call_id}-{function_call_id}",
                        )
                    tool_results[function_call_id] = result
                    await emit(
                        "toolCallEnd",
                        {**playback.snapshot(), "tool": name},
                        (time.monotonic() - tool_started) * 1000,
                    )
                    responses.append(
                        {
                            "id": call.get("id"),
                            "name": name,
                            "response": {"result": result},
                        }
                    )
                if responses:
                    await playback.drain()
                    await gemini.send(
                        json.dumps({"toolResponse": {"functionResponses": responses}})
                    )
                    customer_transcript = ""
                if close_requested.is_set():
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
    await output.enqueue(bytes(960))
    generation = output.active_generation_id
    await output.interrupt("test_barge_in")
    await output.drain()
    assert generation in output.cancelled_generations
    assert output.buffered_ms == 0
    await output.enqueue(bytes(640))
    await output.generation_complete()
    await output.drain()
    assert len(writer.frames) == 2
    assert [name for name, _ in events].count("playbackStart") == 1
    assert [name for name, _ in events].count("playbackComplete") == 1
    worker.cancel()
    await asyncio.gather(worker, return_exceptions=True)
    print(json.dumps({"status": "passed", "frames": len(writer.frames)}))


if __name__ == "__main__":
    import sys

    asyncio.run(self_test() if "--self-test" in sys.argv else main())
