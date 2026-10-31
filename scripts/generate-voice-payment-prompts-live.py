#!/usr/bin/env python3
"""Record the secure payment line's prompts with the same Gemini Live model and voice as the AI
ordering assistant, so callers hear one voice end to end (owner request 2026-10-26).

Run inside the phone container (it has the API key and websockets):
  docker exec -i corner-ops-asterisk python3 - < scripts/generate-voice-payment-prompts-live.py
then copy /tmp/voice-payment-prompts/*.wav into asterisk/voice-payment-prompts/.
Prompt texts come from scripts/generate-voice-payment-prompts.py (passed on stdin's sibling copy).
"""
import asyncio, base64, json, os, pathlib, sys, wave
import websockets

PROMPTS = json.loads(os.environ["PROMPTS_JSON"])
MODEL = os.environ.get("LIVE_MODEL", "gemini-3.1-flash-live-preview")
VOICE = os.environ.get("GEMINI_PHONE_VOICE", "Kore")
KEY = os.environ["GEMINI_API_KEY"]
OUT = pathlib.Path("/tmp/voice-payment-prompts"); OUT.mkdir(exist_ok=True)
URL = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={KEY}"

async def record(name, text):
    async with websockets.connect(URL, max_size=None) as g:
        await g.send(json.dumps({"setup": {"model": f"models/{MODEL}", "generationConfig": {"responseModalities": ["AUDIO"], "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOICE}}, "languageCode": "en-US"}},
            "systemInstruction": {"parts": [{"text": "You are Corner Deli's friendly phone assistant. When asked to say a sentence, say exactly that sentence once, warmly and clearly, and nothing else."}]}}}))
        await g.recv()
        await g.send(json.dumps({"clientContent": {"turns": [{"role": "user", "parts": [{"text": f'Say exactly: "{text}"'}]}], "turnComplete": True}}))
        pcm = b""
        while True:
            m = json.loads(await asyncio.wait_for(g.recv(), 60))
            for part in m.get("serverContent", {}).get("modelTurn", {}).get("parts", []):
                if part.get("inlineData", {}).get("data"): pcm += base64.b64decode(part["inlineData"]["data"])
            if m.get("serverContent", {}).get("turnComplete"): break
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(pcm)
    print(name, round(len(pcm) / 48000, 1), "s", flush=True)

async def main():
    for name, text in PROMPTS.items(): await record(name, text)

asyncio.run(main())
