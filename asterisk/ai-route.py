#!/usr/bin/env python3
"""AGI helper: ask the app where an incoming AI call goes, or how a Gemini call ended, and set the answer as a
channel variable. The internal secret stays in this process's environment. Before (2026-11-07) the dialplan
set it as a CURLOPT header, and Asterisk's verbose log printed it on every call.

  AGI(/usr/local/bin/corner-ops-ai-route,route,<URI-encoded caller>,<did>)  -> AI_ROUTE
  AGI(/usr/local/bin/corner-ops-ai-route,status,<call id>)                  -> GEMINI_RESULT
"""
import os
import sys
import urllib.parse
import urllib.request

APP_URL = os.environ.get("GEMINI_PHONE_APP_URL", "http://127.0.0.1:3000").rstrip("/")


def lookup(action, values):
    if action == "route":
        caller, did = (values + ["", ""])[:2]
        # The caller arrives already URI-encoded by the dialplan (URIENCODE), exactly as the old CURL sent it.
        return "AI_ROUTE", f"{APP_URL}/api/internal/ai-phone?caller={caller}&did={urllib.parse.quote(did)}"
    if action == "status":
        return "GEMINI_RESULT", f"{APP_URL}/api/internal/ai-phone?action=status&callId={urllib.parse.quote((values + [''])[0])}"
    raise SystemExit(f"unknown action {action}")


def main():
    while True:  # AGI environment block, ended by a blank line
        line = sys.stdin.readline()
        if not line or not line.strip():
            break
    variable, url = lookup(sys.argv[1] if len(sys.argv) > 1 else "", sys.argv[2:])
    request = urllib.request.Request(url, headers={"x-voice-payment-secret": os.environ.get("VOICE_PAYMENT_INTERNAL_SECRET", "")})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            value = response.read().decode("utf-8", "replace").strip()
    except Exception:
        value = ""  # same as a failed CURL(): the dialplan falls through to its default
    value = value.replace('"', "").replace("\n", " ")[:500]
    sys.stdout.write(f'SET VARIABLE {variable} "{value}"\n')
    sys.stdout.flush()
    sys.stdin.readline()


if __name__ == "__main__":
    main()
