# 3CX Professional CDR integration

Corner Ops receives durable 3CX Call Data Records through a small cross-platform Node.js socket receiver. This does not require the Enterprise Call Control API.

For a self-hosted Linux 3CX system, run the receiver as a hardened `systemd` service either on the PBX itself or on another always-on Linux host that can reach the CDR socket. Do not install it on a vendor-managed 3CX host where custom services are prohibited.

## 1. Configure these Vercel environment variables

- `THREE_CX_CDR_SECRET`: a long random secret shared with the receiver.
- `THREE_CX_DELI_QUEUE=90`
- `THREE_CX_DELI_EXTENSIONS`: comma-separated Deli extension numbers.
- `THREE_CX_IGNORE_SECONDS=4`
- `THREE_CX_ISSUE_SECONDS=30`

Preview deployments protected by Vercel Authentication also require an automation bypass secret. Put that value in the receiver as `VERCEL_PROTECTION_BYPASS`. Production does not need it unless Deployment Protection is enabled there too.

## 2. Configure the 3CX CDR fields in this exact order

1. historyid
2. callid
3. duration
4. time-start
5. time-answered
6. time-end
7. reason-terminated
8. from-no
9. to-no
10. from-dn
11. to-dn
12. dial-no
13. reason-changed
14. final-number
15. final-dn
16. chain
17. from-type
18. to-type
19. final-type
20. from-dispname
21. to-dispname
22. final-dispname
23. missed-queue-calls

Keep comma delimiters enabled. The receiver supports quoted commas in names.

## 3. Choose the socket direction

### Recommended on the Linux PBX: receiver connects to 3CX

Configure 3CX as **Server / Passive Socket** on a local TCP port, such as `5483`. Bind or firewall that port so only localhost or the receiver host can reach it.

Create `/etc/corner-ops/3cx-cdr.env`:

```bash
CDR_MODE=connect
CDR_HOST=127.0.0.1
CDR_PORT=5483
CORNER_OPS_URL=https://your-corner-ops-host
CORNER_OPS_CDR_SECRET=the-same-secret-as-vercel
CDR_SPOOL_FILE=/var/lib/corner-ops-cdr/spool.jsonl
# VERCEL_PROTECTION_BYPASS=preview-bypass-secret
```

Install the files:

```bash
sudo useradd --system --home /opt/corner-ops-cdr --shell /usr/sbin/nologin cornerops
sudo install -d -o cornerops -g cornerops /opt/corner-ops-cdr /var/lib/corner-ops-cdr
sudo install -d -m 0750 /etc/corner-ops
sudo install -o cornerops -g cornerops -m 0755 tools/3cx-cdr-receiver.mjs /opt/corner-ops-cdr/3cx-cdr-receiver.mjs
sudo install -m 0644 tools/3cx-cdr-receiver.service /etc/systemd/system/corner-ops-3cx-cdr.service
sudo chmod 0600 /etc/corner-ops/3cx-cdr.env
sudo systemctl daemon-reload
sudo systemctl enable --now corner-ops-3cx-cdr
sudo journalctl -u corner-ops-3cx-cdr -f
```

### 3CX connects to a separate receiver host

Configure 3CX as **Client / Active Socket** and run the receiver on an address reachable by the PBX:

```bash
CDR_MODE=listen
CDR_HOST=0.0.0.0
CDR_PORT=5483
CORNER_OPS_URL=https://your-corner-ops-host
CORNER_OPS_CDR_SECRET=the-same-secret-as-vercel
CDR_SPOOL_FILE=/var/lib/corner-ops-cdr/spool.jsonl
```

Restrict the listener port to the PBX source IP. The receiver forwards records to Corner Ops over HTTPS and keeps failed deliveries in the local spool for automatic retry.

## 4. View the report

Open **Reports → Deli calls**. Corner Ops:

- ignores calls lasting four seconds or less;
- identifies abandoned queue 90 calls;
- calculates the wait from call start to termination;
- checks whether configured Deli extensions were already on answered calls at the drop time;
- finds later answered inbound or outbound contact with the same caller;
- flags a 30-second-or-longer unresolved abandonment with no other active Deli calls as an operational issue.

## Live POS caller-ID popup with 3CX Professional

Upload `public/downloads/CornerOps-3CX-CRM.xml` in **Admin → Integrations → CRM**. Configure:

- **Corner Ops URL:** `https://dev.ordercornerdeli.com`
- **Corner Ops CRM Secret:** the same long random value configured as `THREE_CX_CRM_SECRET`

Enable CRM contact lookup for Deli extensions 95 and 96. The lookup occurs while the call is ringing, records a short-lived live-call event, matches the phone number to the Corner Deli customer database, and causes the POS caller popup. The CDR socket remains separately responsible for completed and missed-call reporting.
