#!/usr/bin/env python3
"""Compares staging (:3002) with the production reference (:3003) for the given API paths.
Prints only which fields differ, never values. Usage: compare-with-production.py /api/... [...]"""
import json, os, subprocess, urllib.request, http.cookiejar, sys
ADDRESS = os.environ.get("STAGING_ADDRESS") or subprocess.run(["sh", "-c", "ip -4 route get 1.1.1.1 | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p'"], capture_output=True, text=True).stdout.strip()
cred = open("/opt/corner-ops/staging/test-owner").read().split()
def client(base):
    cookie = {}
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k): return None
    op = urllib.request.build_opener(NoRedirect())
    def call(path, data=None):
        headers = {"content-type":"application/json","origin":base}
        if cookie: headers["cookie"] = "; ".join(f"{k}={v}" for k, v in cookie.items())
        req = urllib.request.Request(base+path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
        try:
            r = op.open(req, timeout=120); status, body, hdrs = r.status, r.read(), r.headers
        except urllib.error.HTTPError as e: status, body, hdrs = e.code, e.read(), e.headers
        for h in hdrs.get_all("set-cookie") or []:
            name, _, rest = h.partition("="); cookie[name.strip()] = rest.split(";", 1)[0]
        return status, body
    s,_ = call("/api/auth/session", {"email": cred[0], "password": cred[1]}); assert s == 200, (base, s)
    return call
new, old = client("http://"+ADDRESS+":3002"), client("http://"+ADDRESS+":3003")
VOLATILE = {"generatedAt","now","serverTime","responseTimeMs","requestId","csrf","token","expiresAt","updatedAt","checkedAt","asOf"}
def flat(x, p="", out=None):
    out = {} if out is None else out
    if isinstance(x, dict):
        for k, v in x.items():
            if k in VOLATILE: continue
            flat(v, f"{p}.{k}", out)
    elif isinstance(x, list):
        for i, v in enumerate(x): flat(v, f"{p}[{i}]", out)
    else: out[p] = x
    return out
for path in sys.argv[1:]:
    (sn, bn), (so, bo) = new(path), old(path)
    try: jn, jo = json.loads(bn), json.loads(bo)
    except Exception:
        print(f"{'SAME' if (sn,bn)==(so,bo) else 'DIFF'}  {path}  status new={sn} old={so} (not JSON)"); continue
    fn, fo = flat(jn), flat(jo)
    diff = sorted(k for k in set(fn)|set(fo) if fn.get(k, "∅") != fo.get(k, "∅"))
    tag = "SAME" if sn == so and not diff else "DIFF"
    print(f"{tag}  {path}  status new={sn} old={so}  fields new={len(fn)} old={len(fo)} differing={len(diff)}")
    for k in diff[:8]:
        a, b = fn.get(k, "∅"), fo.get(k, "∅")
        kind = "only-new" if b == "∅" else "only-old" if a == "∅" else f"{type(a).__name__}/{type(b).__name__}"
        print(f"        {k[:110]}  [{kind}]")
