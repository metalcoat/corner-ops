#!/usr/bin/env python3
"""Writes /opt/corner-ops/staging/.env from production's settings, made safe to run.

Keeps what staging needs to read production's data (PIN pepper, forms and key
encryption keys, the session secret older PINs were hashed with). Removes every
setting that would let staging text, email, push, call or charge anyone, or touch
an outside account. New cookie secrets, cron secret and database password. MX
uses the dev runtime's sandbox account. Prints setting names only, never values.
"""
import re, secrets, sys
from pathlib import Path

PRODUCTION = Path("/opt/corner-ops/production/.env")
DEV = Path("/opt/corner-ops/.env")
TARGET = Path("/opt/corner-ops/staging/.env")
address = sys.argv[1]

# Anything matching these is dropped: outgoing messages, providers, external accounts.
DROP = re.compile(
    r"^(TELNYX_|TWILIO_|SMS_|SMTP_|RESEND_|PUSH_|VAPID|PLAID_|SQUARE_|REZKU_|GOOGLE_|OPENAI_|GEMINI_|"
    r"THREE_CX_|THREECX|BLOB_|VERCEL_|MX_|HELCIM_|PAYMENT_PROVIDER|ALERT_TO_EMAIL|CLOUDFLARE|TUNNEL|"
    r"VOICE_PAYMENT_|ASTERISK_)"
)
FRESH = ["OWNER_SESSION_SECRET", "EMPLOYEE_SESSION_SECRET", "DELI_BOARD_SESSION_SECRET", "CRON_SECRET", "POSTGRES_PASSWORD"]

def read(path):
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.removeprefix("export ").strip()] = value
    return values

production, dev = read(PRODUCTION), read(DEV)
kept = {k: v for k, v in production.items() if not DROP.match(k)}
dropped = sorted(k for k in production if DROP.match(k))
for key in FRESH:
    kept[key] = secrets.token_urlsafe(48)
url = f"http://{address}:3002"
kept.update({
    "APP_URL": url, "EMPLOYEE_APP_URL": url, "CUSTOMER_APP_URL": url,
    "COOKIE_SECURE": "false", "ALLOWED_HOSTS": address,
    "OPENAI_PHONE_ORDERING_ENABLED": "false", "GEMINI_PHONE_BRIDGE_ENABLED": "false",
    "PAYMENT_PROVIDER": "mx", "MX_ENVIRONMENT": "sandbox", "MX_TERMINAL_API_ENABLED": "false",
})
for key in ("MX_MERCHANT_ID", "MX_API_KEY", "MX_CONSUMER_KEY", "MX_CONSUMER_SECRET", "MX_BUSINESS_ID"):
    if dev.get(key) and dev.get("MX_ENVIRONMENT", "sandbox") == "sandbox":
        kept[key] = dev[key]
TARGET.parent.mkdir(parents=True, exist_ok=True)
TARGET.write_text("".join(f"{k}={v}\n" for k, v in kept.items()))
TARGET.chmod(0o600)
print("Staging settings written to", TARGET)
print("Removed (sends or touches outside accounts):", ", ".join(dropped) or "none")
print("New values:", ", ".join(FRESH))
