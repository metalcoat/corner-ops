#!/usr/bin/env python3
"""Interim Monday payroll email (until the new system runs in production).

Run by monday-payroll-preview.sh after a fresh production backup has been loaded
into staging. Builds last week's Corner Deli payroll on staging, restores the
Payroll Relief employee matches, and emails the owner the summary with a link to
approve it on the staging payroll page. Sends only to PAYROLL_NOTIFY_EMAIL (or
APP_EMAIL) using the server's SMTP settings; never to staff.

  monday-payroll-preview.py [--week YYYY-MM-DD] [--dry-run]
"""
import argparse, json, smtplib, ssl, subprocess, sys, urllib.request
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from zoneinfo import ZoneInfo

STAGING = Path("/opt/corner-ops/staging")
MATCHES = STAGING / "payroll-relief-matches.json"
ENV = Path("/opt/corner-ops/.env")
EASTERN = ZoneInfo("America/New_York")


def env_file(path):
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.removeprefix("export ").strip()] = value.strip().strip("'\"")
    return values


def address():
    out = subprocess.run(["sh", "-c", "ip -4 route get 1.1.1.1 | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p'"], capture_output=True, text=True)
    return out.stdout.strip()


def staging_client(base):
    """Signs in as the staging-only test owner (deploy/staging/add-test-owner.sh)."""
    email, password = (STAGING / "test-owner").read_text().split()[:2]
    cookie = {}

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(NoRedirect())

    def call(path, data=None):
        headers = {"content-type": "application/json", "origin": base}
        if cookie:
            headers["cookie"] = "; ".join(f"{k}={v}" for k, v in cookie.items())
        req = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
        try:
            r = opener.open(req, timeout=120)
            status, body, hdrs = r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            status, body, hdrs = e.code, e.read(), e.headers
        for h in hdrs.get_all("set-cookie") or []:
            name, _, rest = h.partition("=")
            cookie[name.strip()] = rest.split(";", 1)[0]
        return status, body

    status, _ = call("/api/auth/session", {"email": email, "password": password})
    if status != 200:
        sys.exit(f"Staging sign-in failed ({status}).")
    return call


def last_week_start(today):
    monday = today - timedelta(days=today.weekday())
    return monday - timedelta(days=7)


def money(value):
    return f"${float(value or 0):,.2f}"


def hours(value):
    return f"{float(value or 0):.2f}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--week", help="payroll week start (Monday), default last week")
    parser.add_argument("--dry-run", action="store_true", help="print the email instead of sending it")
    parser.add_argument("--subject-prefix", default="", help='e.g. "(test) "')
    args = parser.parse_args()
    week = date.fromisoformat(args.week) if args.week else last_week_start(datetime.now(EASTERN).date())
    week_end = week + timedelta(days=6)
    label = f"{week.month}/{week.day}–{week_end.month}/{week_end.day}"
    base = f"http://{address()}:3002"
    call = staging_client(base)

    # The weekly refresh wipes staging; put the confirmed employee matches back.
    if MATCHES.exists():
        mappings = json.loads(MATCHES.read_text())
        status, body = call("/api/payroll-control", {"action": "payroll-relief-map-save", "business": "Corner Deli", "mappings": mappings})
        print("employee matches restored:", status, body[:80])

    status, body = call("/api/payroll-control", {"action": "draft-create", "business": "Corner Deli", "weekStart": week.isoformat()})
    print("draft:", status)
    status, body = call(f"/api/payroll-control?business=Corner%20Deli&weekStart={week.isoformat()}")
    if status != 200:
        sys.exit(f"Couldn't load the payroll ({status}).")
    data = json.loads(body)
    summary = data.get("summary") or {}
    rows = summary.get("rows") or []
    comparison = summary.get("scheduleComparison") or []
    blockers = (data.get("approval") or {}).get("blockers") or {}

    # Remember the matches for next week's refresh.
    people = ((data.get("approval") or {}).get("payrollRelief") or {}).get("people") or []
    saved = [{"employee": p["employee"], "eeNum": p["eeNum"]} for p in people if p.get("eeNum")]
    if saved:
        MATCHES.write_text(json.dumps(saved, indent=1))
        MATCHES.chmod(0o600)

    any_ot = any(float(r.get("overtimeHours") or 0) for r in rows)
    lines = [f"Corner Deli payroll for {label} (from this morning's copy of production, Sunday included).", ""]
    head = f"{'Employee':<20}{'Regular':>9}{'Tipped':>8}{'Tips':>11}" + (f"{'OT':>7}" if any_ot else "")
    lines += [head, "-" * len(head)]
    totals = {"reg": 0.0, "tip": 0.0, "tips": 0.0, "ot": 0.0}
    for r in sorted(rows, key=lambda r: r.get("employee", "")):
        totals["reg"] += float(r.get("regularHours") or 0)
        totals["tip"] += float(r.get("driverTipHours") or 0)
        totals["tips"] += float(r.get("tips") or 0)
        totals["ot"] += float(r.get("overtimeHours") or 0)
        line = f"{str(r.get('employee', ''))[:19]:<20}{hours(r.get('regularHours')):>9}{hours(r.get('driverTipHours')):>8}{money(r.get('tips')):>11}"
        lines.append(line + (f"{hours(r.get('overtimeHours')):>7}" if any_ot else ""))
    lines.append("-" * len(head))
    lines.append(f"{'Total':<20}{hours(totals['reg']):>9}{hours(totals['tip']):>8}{money(totals['tips']):>11}" + (f"{hours(totals['ot']):>7}" if any_ot else ""))
    lines += ["", "What's off from the schedule:"]
    flagged = [c for c in comparison if c.get("flagged")]
    for c in flagged:
        lines.append(f"  - {c.get('employee')}: {c.get('text')}")
        for missed in c.get("missed") or c.get("missedShiftDetails") or []:
            lines.append(f"      Missed: {missed if isinstance(missed, str) else missed.get('label') or missed}")
    if not flagged:
        lines.append("  Nothing — everyone worked within an hour of their schedule.")
    issues = [f"{k}: {v}" for k, v in blockers.items() if v and k != "message"]
    if issues:
        lines += ["", "Needs attention before approving: " + ", ".join(issues)]
    lines += [
        "",
        f"Review and approve (deli Wi-Fi): {base}/ops/payroll-control?business=Corner%20Deli&weekStart={week.isoformat()}",
        "After you approve, tell Claude and the hours are entered in Payroll Relief (saved, not submitted);",
        "then review and press Submit in Payroll Relief yourself.",
        "",
        "Fixes made on the staging page only change this payroll; fix punches permanently in Rezku/production.",
    ]
    text = "\n".join(lines)

    settings = env_file(ENV)
    to = settings.get("PAYROLL_NOTIFY_EMAIL") or settings.get("APP_EMAIL")
    sender = settings.get("ALERT_FROM_EMAIL") or settings.get("CUSTOMER_EMAIL_FROM") or settings.get("SMTP_USER")
    message = EmailMessage()
    message["Subject"] = f"{args.subject_prefix}Corner Deli payroll {label}: review and approve"
    message["From"] = sender
    message["To"] = to
    message.set_content(text)
    if args.dry_run:
        print(f"To: {to}\nSubject: {message['Subject']}\n\n{text}")
        return
    host, port = settings["SMTP_HOST"], int(settings.get("SMTP_PORT") or 465)
    secure = (settings.get("SMTP_SECURE") or "true").lower() != "false"
    smtp = smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=60) if secure else smtplib.SMTP(host, port, timeout=60)
    with smtp:
        if not secure:
            smtp.starttls(context=ssl.create_default_context())
        smtp.login(settings["SMTP_USER"], settings["SMTP_PASSWORD"])
        smtp.send_message(message)
    print(f"Emailed {to}: {message['Subject']}")


if __name__ == "__main__":
    main()
