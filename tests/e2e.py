#!/usr/bin/env python3
"""End-to-end smoke test. Requires a running server + seeded Postgres.

    python3 tests/e2e.py
"""
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request
import uuid

BASE = "http://127.0.0.1:8099"
HDR = {"Content-Type": "application/json", "X-Requested-With": "autopilot-forex"}
failures = []


class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method, path, body=None, headers=True):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(BASE + path, data=data, method=method)
        if headers:
            for k, v in HDR.items():
                req.add_header(k, v)
        try:
            with self.opener.open(req, timeout=20) as r:
                raw = r.read()
                try:
                    return r.status, json.loads(raw or b"{}")
                except json.JSONDecodeError:
                    return r.status, raw.decode(errors="replace")[:200]
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return e.code, raw.decode(errors="replace")[:200]

    def get(self, path):
        return self.call("GET", path)

    def post(self, path, body):
        return self.call("POST", path, body)

    def patch(self, path, body):
        return self.call("PATCH", path, body)


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" :: {detail}"))
    if not ok:
        failures.append(name)


anon = Client()
user = Client()
admin = Client()

email = f"trader-{uuid.uuid4().hex[:8]}@test.local"

s, b = user.post("/api/auth/register", {"fullName": "Test Trader", "email": email, "password": "GoldDesk#2026"})
check("register", s == 201 and b.get("user", {}).get("email") == email, f"{s} {b}")
check("register sets cookies", len(list(user.jar)) >= 2)

s, b = user.get("/api/auth/me")
check("me", s == 200 and b["user"]["email"] == email, f"{s} {b}")

s, b = anon.call("POST", "/api/auth/register", {"fullName": "X Y", "email": email, "password": "GoldDesk#2026"})
check("duplicate email rejected", s == 409, f"{s} {b}")

s, b = anon.call("POST", "/api/auth/login", {"email": email, "password": "wrong-password"})
check("bad password rejected", s == 401, f"{s} {b}")

s, b = admin.post("/api/auth/login", {"email": "owner@test.local", "password": "TestOwner#2026"})
check("admin login", s == 200 and b["user"]["role"] == "OWNER", f"{s} {b}")

s, b = user.get("/api/admin/stats")
check("user blocked from admin", s == 403, f"{s} {b}")

s, b = admin.post("/api/admin/signals", {
    "pair": "XAU/USD", "direction": "BUY", "entry": 2384.6,
    "stopLoss": 2368, "takeProfit": 2420, "confidence": 72,
    "vipOnly": True, "notes": "e2e signal",
})
check("admin creates vip signal", s == 201, f"{s} {b}")

s, b = anon.get("/api/public/signals")
check("anon sees locked signal", s == 200 and b["items"][0]["locked"] is True, f"{s} {b}")

s, b = user.get("/api/public/signals")
check("free user sees locked signal", b["items"][0]["locked"] is True and b["vip"] is False, f"{s} {b}")

s, b = admin.get(f"/api/admin/users?q={email}")
uid = b["items"][0]["id"] if s == 200 and b.get("items") else None
check("admin finds user", bool(uid), f"{s} {b}")

s, b = admin.post(f"/api/admin/users/{uid}/grant", {"planCode": "vip-monthly", "months": 1})
check("admin grants vip", s == 200 and b["subscription"]["status"] == "ACTIVE", f"{s} {b}")

s, b = user.get("/api/public/signals")
check("vip user sees unlocked signal", b["items"][0]["locked"] is False, f"{s} {b}")

s, b = user.get("/api/me")
check("me shows membership", b["membership"]["vip"] is True, f"{s} {b}")

s, b = user.post("/api/billing/checkout", {"planCode": "vip-monthly", "provider": "stripe"})
check("stripe not configured -> 503", s == 503 and b["error"]["code"] == "not_configured", f"{s} {b}")

s, b = user.post("/api/billing/checkout", {"planCode": "vip-monthly-kes", "provider": "mpesa"})
check("mpesa not configured -> 503", s == 503, f"{s} {b}")

s, b = anon.post("/api/contact", {"name": "Jane Doe", "email": "jane@test.local", "subject": "Question", "message": "How do I join the next session?"})
check("contact message stored", s == 200 and b.get("ok"), f"{s} {b}")

s, b = user.call("POST", "/api/billing/cancel", {}, headers=False)
check("csrf header enforced", s == 403, f"{s} {b}")

s, b = user.post("/api/billing/cancel", {})
check("cancel marks period end", s == 200 and b["membership"]["cancelAtPeriodEnd"] is True, f"{s} {b}")

s, b = admin.get("/api/admin/stats")
check("admin stats", s == 200 and b["users"] >= 1 and b["activeSubscriptions"] >= 1, f"{s} {b}")

s, b = admin.get("/api/admin/audit")
check("audit trail populated", s == 200 and b["total"] >= 3, f"{s} {b}")

s, b = user.post("/api/auth/logout", {})
check("logout", s == 200 and b.get("ok"), f"{s} {b}")

s, b = user.get("/api/auth/me")
check("session cleared after logout", s == 401, f"{s} {b}")

s, b = anon.call("GET", "/api/public/site")
check("public site config", s == 200 and len(b["plans"]) >= 2, f"{s} {b}")

print()
if failures:
    print(f"{len(failures)} FAILED: {', '.join(failures)}")
    sys.exit(1)
print("All checks passed.")
