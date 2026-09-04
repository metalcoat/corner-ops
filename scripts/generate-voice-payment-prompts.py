#!/usr/bin/env python3
"""Generate fixed non-sensitive payment prompts with Gemini TTS."""
import base64
import json
import os
import pathlib
import urllib.request
import urllib.error
import time
import wave

PROMPTS={
    "welcome":"You are now on our secure payment line. Your payment information is not sent to the ordering assistant or saved in a transcript.",
    "card-number":"Okay, start with the first four numbers.",
    "next-four":"Now say the next four digits.",
    "last-four":"Now say the last four digits.",
    "next-six":"Now say the next six digits.",
    "last-five":"Now say the last five digits.",
    "expiration":"Say the two digit expiration month, followed by the two digit year.",
    "security-code":"Say the three or four digit security code.",
    "billing-zip":"Say the five digit billing zip code.",
    "confirm-ending":"I heard a card ending in",
    "confirm-yes":"Say yes if that is correct, or no to try again.",
    "try-again":"I did not understand that group. Please say each digit clearly.",
    "processing":"Please wait while I securely process the sandbox payment.",
    "approved":"Your test payment was approved and your order is complete. Thank you for calling Corner Deli.",
    "employee-help":"I could not complete the secure test payment. I will transfer you to an employee.",
}

def main():
    key=os.environ.get("GEMINI_API_KEY","").strip()
    if not key:raise SystemExit("GEMINI_API_KEY is required")
    output=pathlib.Path("asterisk/voice-payment-prompts");output.mkdir(parents=True,exist_ok=True)
    url="https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent"
    for name,text in PROMPTS.items():
        destination=output/f"{name}.wav"
        if destination.exists() and destination.stat().st_size>44:continue
        body={"contents":[{"parts":[{"text":f"Speak warmly, clearly, and naturally at a calm phone-service pace. Say exactly: {text}"}]}],"generationConfig":{"responseModalities":["AUDIO"],"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Kore"}}}}}
        request=urllib.request.Request(url,data=json.dumps(body).encode(),headers={"content-type":"application/json","x-goog-api-key":key},method="POST")
        for attempt in range(5):
            try:
                with urllib.request.urlopen(request,timeout=60) as response:data=json.loads(response.read())
                break
            except urllib.error.HTTPError as error:
                if error.code!=429 or attempt==4:raise
                time.sleep(15*(attempt+1))
        pcm=base64.b64decode(data["candidates"][0]["content"]["parts"][0]["inlineData"]["data"])
        with wave.open(str(destination),"wb") as target:
            target.setnchannels(1);target.setsampwidth(2);target.setframerate(24000);target.writeframes(pcm)
        time.sleep(4)

if __name__=="__main__":main()
