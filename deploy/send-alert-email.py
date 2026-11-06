#!/usr/bin/env python3
"""Email an operations alert to the owner with the app's own SMTP settings (the transactional-email path:
SMTP_HOST/PORT/SECURE/USER/PASSWORD, from CUSTOMER_EMAIL_FROM). Recipient: ALERT_TO_EMAIL, else APP_EMAIL.
Usage: send-alert-email.py "<subject>" < body.txt     (reads /opt/corner-ops/.env; prints no secrets)"""
import smtplib
import ssl
import sys
from email.message import EmailMessage

ENV_FILE = "/opt/corner-ops/.env"


def load_env(path):
    values = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    return values


def main():
    env = load_env(ENV_FILE)
    subject = sys.argv[1] if len(sys.argv) > 1 else "Corner Ops server alert"
    body = sys.stdin.read()
    user, password = env.get("SMTP_USER", ""), env.get("SMTP_PASSWORD", "")
    sender = env.get("CUSTOMER_EMAIL_FROM") or user
    recipient = env.get("ALERT_TO_EMAIL") or env.get("APP_EMAIL")
    if not (user and password and sender and recipient):
        print("alert email not configured (SMTP_USER/SMTP_PASSWORD/APP_EMAIL)", file=sys.stderr)
        return 1
    message = EmailMessage()
    message["Subject"], message["From"], message["To"] = subject, sender, recipient
    message.set_content(body)
    host, port = env.get("SMTP_HOST") or "smtp.hostinger.com", int(env.get("SMTP_PORT") or 465)
    if (env.get("SMTP_SECURE") or "true").lower() == "true":
        with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=30) as server:
            server.login(user, password)
            server.send_message(message)
    else:
        with smtplib.SMTP(host, port, timeout=30) as server:
            server.starttls(context=ssl.create_default_context())
            server.login(user, password)
            server.send_message(message)
    print("alert email sent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
