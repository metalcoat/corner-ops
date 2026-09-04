#!/usr/bin/env python3
"""Asterisk AudioSocket to Gemini Live bridge. Never handles card data."""

import asyncio
import audioop
import base64
import json
import os
import struct
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


async def mcp_call(call_id, name, arguments):
    body = await asyncio.to_thread(
        http_json,
        f"{APP_URL}/api/openai/ordering/mcp",
        "POST",
        {
            "jsonrpc": "2.0",
            "id": f"gemini-{call_id}-{name}",
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
    async with websockets.connect(url, max_size=None, ping_interval=20) as gemini:
        await gemini.send(
            json.dumps(
                {
                    "setup": {
                        "model": f"models/{model}",
                        "generationConfig": {"responseModalities": ["AUDIO"]},
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
            while not close_requested.is_set():
                kind, payload = await read_packet(reader)
                if kind == 0x00:
                    break
                if kind == 0x10 and payload:
                    await gemini.send(
                        json.dumps(
                            {
                                "realtimeInput": {
                                    "audio": {
                                        "data": base64.b64encode(payload).decode(),
                                        "mimeType": "audio/pcm;rate=8000",
                                    }
                                }
                            }
                        )
                    )

        async def model_audio():
            nonlocal output_state
            async for raw in gemini:
                message = json.loads(raw)
                server = message.get("serverContent", {})
                for part in server.get("modelTurn", {}).get("parts", []):
                    inline = part.get("inlineData", {})
                    if inline.get("data"):
                        pcm24 = base64.b64decode(inline["data"])
                        pcm8, output_state = audioop.ratecv(
                            pcm24, 2, 1, 24000, 8000, output_state
                        )
                        await write_audio(writer, pcm8)
                tool_call = message.get("toolCall", {})
                responses = []
                for call in tool_call.get("functionCalls", []):
                    name = call.get("name", "")
                    arguments = call.get("args", {})
                    if name == "request_human_handoff":
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
                        result = await app_action(call_id, "complete")
                        close_requested.set()
                    else:
                        result = await mcp_call(call_id, name, arguments)
                    responses.append(
                        {
                            "id": call.get("id"),
                            "name": name,
                            "response": {"result": result},
                        }
                    )
                if responses:
                    await gemini.send(
                        json.dumps({"toolResponse": {"functionResponses": responses}})
                    )
                if close_requested.is_set():
                    break

        tasks = [asyncio.create_task(caller_audio()), asyncio.create_task(model_audio())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            if not task.cancelled():
                task.result()


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


if __name__ == "__main__":
    asyncio.run(main())
