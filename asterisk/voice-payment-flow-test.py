"""End-to-end test of the secure payment line (asterisk/voice-payment.py) against a fake Asterisk.

Runs the real EAGI script as a subprocess: AGI commands on stdin/stdout, caller audio on fd 3 in
real time (natural-voice clips from tests/fixtures/payment-voice through a phone codec), keypad
presses as AGI results, and a fake payment API. Checks what gets charged. Not a real phone call.
Run inside the phone image: python3 voice-payment-flow-test.py voice-payment.py <clips dir>
"""
import http.server
import json
import os
import random
import re
import subprocess
import sys
import threading
import time

SCRIPT, CLIPS = sys.argv[1], sys.argv[2]
NAMES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
random.seed(5)


def clip(voice, word):
    return subprocess.run(
        ["sox", f"{CLIPS}/{voice}--{word}.wav", "-r", "16000", "-c", "1", "-e", "signed-integer", "-b", "16", "-t", "raw", "-"],
        capture_output=True, check=True,
    ).stdout


def silence(seconds):
    return b"\x00\x00" * int(16000 * seconds)


def speech(voice, groups):
    """Words grouped the way people read a card, through an 8 kHz mu-law phone leg."""
    raw = silence(0.3)
    for group in groups:
        for word in group:
            raw += clip(voice, word) + silence(random.uniform(0.05, 0.15))
        raw += silence(random.uniform(0.35, 0.6))
    return subprocess.run(
        "sox -t raw -r 16000 -e signed-integer -b 16 -c 1 - -r 8000 -e mu-law -t wav - | sox -t wav - -r 16000 -e signed-integer -b 16 -t raw -",
        shell=True, input=raw, capture_output=True, check=True,
    ).stdout


def digits(voice, value, size=4):
    return speech(voice, [[NAMES[int(d)] for d in value[i:i + size]] for i in range(0, len(value), size)])


class Api(http.server.BaseHTTPRequestHandler):
    calls = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        Api.calls.append(body)
        reply = {"sessionId": "session-1"} if body["action"] == "claim" else {"approved": True}
        data = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Api)
threading.Thread(target=server.serve_forever, daemon=True).start()


def run(answers):
    """answers: prompt name -> list of ('say', pcm) / ('keys', '4111...#') / ('nothing', None), used in order."""
    Api.calls = []
    audio_read, audio_write = os.pipe()
    env = {**os.environ, "VOICE_PAYMENT_API_URL": f"http://127.0.0.1:{server.server_port}/", "VOICE_PAYMENT_INTERNAL_SECRET": "test"}
    process = subprocess.Popen(
        ["sh", "-c", f'exec python3 -W ignore "$0" call-1 3155550100 3<&{audio_read}', SCRIPT],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        pass_fds=(audio_read,), env=env,
    )
    os.close(audio_read)
    process.stdin.write("agi_callerid: 3155550100\n\n")
    process.stdin.flush()
    prompts, pending_keys, result = [], [], None
    feeder = None

    def feed(pcm, delay=0.25):
        time.sleep(delay)  # by default the caller starts after the prompt ends
        for i in range(0, len(pcm), 3200):
            os.write(audio_write, pcm[i:i + 3200])
            time.sleep(0.1)

    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        line = process.stdout.readline()
        if not line:
            break
        command = line.strip()
        reply = "200 result=0"
        stream = re.match(r'STREAM FILE voice-payment/(\S+) "([^"]*)"', command)
        if stream:
            name, escape = stream.groups()
            prompts.append(name)
            queue = answers.get(name, [])
            if escape and queue:
                kind, value = queue.pop(0)
                if kind == "keys":
                    pending_keys = list(value[1:])
                    reply = f"200 result={ord(value[0])} endpos=100"
                elif kind == "say":
                    feeder = threading.Thread(target=feed, args=(value,), daemon=True)
                    feeder.start()
                elif kind == "over":
                    # The caller starts answering while the prompt is still playing (prompt lasts 2.5 s).
                    feeder = threading.Thread(target=feed, args=(value, 0.0), daemon=True)
                    feeder.start()
                    time.sleep(2.5)
        elif command.startswith("WAIT FOR DIGIT"):
            if pending_keys:
                reply = f"200 result={ord(pending_keys.pop(0))}"
            else:
                time.sleep(int(command.split()[-1]) / 1000)
        elif command.startswith("SET VARIABLE VOICE_PAYMENT_RESULT"):
            result = command.split()[-1]
        process.stdin.write(reply + "\n")
        process.stdin.flush()
        if result:
            break
    process.stdin.close()
    process.wait(timeout=10)
    os.close(audio_write)
    charge = next((call for call in Api.calls if call["action"] == "charge"), None)
    return {"result": result, "prompts": prompts, "charge": charge, "stderr": process.stderr.read()[-400:]}


VISA, AMEX = "4111111111111111", "378282246310005"
checks = []


def check(name, outcome, card, expiry="0428", cvv="123", zipcode="13669"):
    charge = outcome["charge"] or {}
    ok = (
        outcome["result"] == "approved"
        and charge.get("cardNumber") == card
        and charge.get("expiryMonth") + charge.get("expiryYear") == expiry
        and charge.get("cvv") == cvv
        and charge.get("avsZip") == zipcode
    )
    checks.append(name)
    assert ok, f"{name}: {json.dumps({k: v for k, v in outcome.items() if k != 'charge'})} charged={bool(outcome['charge'])}"


expiry_speech = lambda voice: speech(voice, [["oh", "four", "twenty_eight"]])

# 1. Everything spoken, whole card number in one go.
voice = "Kore"
check("all spoken", run({
    "say-card-number": [("say", digits(voice, VISA))],
    "say-confirm": [("say", speech(voice, [["yes"]]))],
    "say-expiration": [("say", expiry_speech(voice))],
    "say-security-code": [("say", digits(voice, "123", 3))],
    "say-billing-zip": [("say", digits(voice, "13669", 5))],
}), VISA)

# 2. Everything on the keypad (speech is never required).
check("all keyed", run({
    "say-card-number": [("keys", VISA + "#")],
    "say-confirm": [("keys", "1")],
    "say-expiration": [("keys", "0428")],
    "say-security-code": [("keys", "123")],
    "say-billing-zip": [("keys", "13669")],
}), VISA)

# 3. A garbled first try (a digit missing) falls back to four at a time.
voice = "Aoede"
check("bad whole number then groups", run({
    "say-card-number": [("say", digits(voice, VISA[:7] + VISA[8:]))],
    "card-number": [("say", digits(voice, VISA[0:4]))],
    "next-four": [("say", digits(voice, VISA[4:8])), ("say", digits(voice, VISA[8:12]))],
    "last-four": [("say", digits(voice, VISA[12:16]))],
    "say-confirm": [("say", speech(voice, [["yes"]]))],
    "say-expiration": [("say", expiry_speech(voice))],
    "say-security-code": [("say", digits(voice, "123", 3))],
    "say-billing-zip": [("say", digits(voice, "13669", 5))],
}), VISA)

# 4. Amex reads 4-6-5 and needs a 4-digit code; a wrong-length keyed zip is asked again.
voice = "Aoede"
check("amex, wrong keyed zip", run({
    "say-card-number": [("say", speech(voice, [[NAMES[int(d)] for d in AMEX[0:4]], [NAMES[int(d)] for d in AMEX[4:10]], [NAMES[int(d)] for d in AMEX[10:]]]))],
    "say-expiration": [("keys", "0428")],
    "say-security-code": [("say", digits(voice, "4567"))],
    "say-billing-zip": [("keys", "1366#"), ("keys", "13669")],
}), AMEX, cvv="4567")

# 6. Talking over the prompts: the answer starts before the prompt finishes and is still heard whole.
voice = "Kore"
check("talk over prompts", run({
    "say-card-number": [("over", digits(voice, VISA))],
    "say-confirm": [("over", speech(voice, [["yes"]]))],
    "say-expiration": [("over", expiry_speech(voice))],
    "say-security-code": [("over", digits(voice, "123", 3))],
    "say-billing-zip": [("over", digits(voice, "13669", 5))],
}), VISA)

# 5. Silence everywhere: the caller goes to an employee and nothing is charged.
outcome = run({})
checks.append("silence hands off")
assert outcome["result"] == "failed" and outcome["charge"] is None, outcome
assert any(call["action"] == "abandon" for call in Api.calls), Api.calls

sys.stdout.write(json.dumps({"status": "passed", "checks": checks}) + "\n")
