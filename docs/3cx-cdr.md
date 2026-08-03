# 3CX Professional CDR integration

Corner Ops receives durable 3CX Call Data Records through a small Node.js socket receiver. This does not require the Enterprise Call Control API.

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

### Receiver connects to 3CX

Use 3CX **Server / Passive Socket** and run:

```powershell
$env:CDR_MODE="connect"
$env:CDR_HOST="your-pbx-host"
$env:CDR_PORT="5483"
$env:CORNER_OPS_URL="https://your-corner-ops-host"
$env:CORNER_OPS_CDR_SECRET="the-same-secret-as-vercel"
node tools/3cx-cdr-receiver.mjs
```

### 3CX connects to the receiver

Use 3CX **Client / Active Socket** and run the receiver on an address reachable by the PBX:

```powershell
$env:CDR_MODE="listen"
$env:CDR_HOST="0.0.0.0"
$env:CDR_PORT="5483"
$env:CORNER_OPS_URL="https://your-corner-ops-host"
$env:CORNER_OPS_CDR_SECRET="the-same-secret-as-vercel"
node tools/3cx-cdr-receiver.mjs
```

Install the receiver as a Windows service with NSSM, WinSW, or Task Scheduler after a successful foreground test.

## 4. View the report

Open **Reports → Deli calls**. Corner Ops:

- ignores calls lasting four seconds or less;
- identifies abandoned queue 90 calls;
- calculates the wait from call start to termination;
- checks whether configured Deli extensions were already on answered calls at the drop time;
- finds later answered inbound or outbound contact with the same caller;
- flags a 30-second-or-longer unresolved abandonment with no other active Deli calls as an operational issue.
