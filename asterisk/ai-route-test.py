"""Test for asterisk/ai-route.py, the AGI helper that replaced the dialplan CURL calls (2026-11-07: the
CURLOPT header put the internal secret into Asterisk's verbose log). A fake app checks the secret header;
the script's AGI output must carry the answer and never the secret.
Run: python3 asterisk/ai-route-test.py asterisk/ai-route.py"""
import http.server
import json
import os
import subprocess
import sys
import threading

SCRIPT = sys.argv[1] if len(sys.argv) > 1 else "/usr/local/bin/corner-ops-ai-route"
SECRET = "test-secret-not-real"
seen = []


class App(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        seen.append(self.path)
        if self.headers.get("x-voice-payment-secret") != SECRET:
            self.send_response(401); self.end_headers(); return
        body = b"payment" if "action=status" in self.path else b"gemini|11111111-2222-3333-4444-555555555555|3155550142"
        self.send_response(200); self.end_headers(); self.wfile.write(body)

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), App)
threading.Thread(target=server.serve_forever, daemon=True).start()


def agi(args, secret=SECRET):
    env = {**os.environ, "GEMINI_PHONE_APP_URL": f"http://127.0.0.1:{server.server_port}", "VOICE_PAYMENT_INTERNAL_SECRET": secret}
    done = subprocess.run([sys.executable, SCRIPT, *args], input="agi_request: test\n\n200 result=1\n", capture_output=True, text=True, env=env, timeout=20)
    return done.stdout + done.stderr


checks = []
out = agi(["route", "%22Caller%22%3Csip%3A3155550142%40pbx%3E", "+13155550100"])
checks.append("route sets AI_ROUTE")
assert out.strip() == 'SET VARIABLE AI_ROUTE "gemini|11111111-2222-3333-4444-555555555555|3155550142"', out
assert "caller=%22Caller%22%3Csip%3A3155550142%40pbx%3E" in seen[-1] and "did=%2B13155550100" in seen[-1], seen[-1]
out = agi(["status", "11111111-2222-3333-4444-555555555555"])
checks.append("status sets GEMINI_RESULT")
assert out.strip() == 'SET VARIABLE GEMINI_RESULT "payment"', out
out = agi(["route", "x", "y"], secret="wrong")
checks.append("a refused lookup sets an empty value, like a failed CURL")
assert out.strip() == 'SET VARIABLE AI_ROUTE ""', out
checks.append("the secret never appears in AGI output")
assert SECRET not in agi(["route", "x", "y"]) + agi(["status", "z"])
print(json.dumps({"status": "passed", "checks": checks}))
