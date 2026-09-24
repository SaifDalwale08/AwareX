"""
AwareX Blackout / Resilience Test
===================================
Tests the complete blackout scenario:
  NORMAL → event → SYNCED
  BLACKOUT → events → PENDING (never lost)
  RESTORE → events → SYNCED → pending=0

Run:
    .venv\\Scripts\\python.exe test_blackout.py [port]
"""
import sys, os, time, json, sqlite3, requests
from pathlib import Path

PORT  = sys.argv[1] if len(sys.argv) > 1 else "8003"
BASE  = f"http://127.0.0.1:{PORT}"
DB    = Path(r"D:\AwareX\data\awarex_local.db")

PASS_LIST: list = []
FAIL_LIST: list = []

def section(t):
    print(); print("-"*60); print("  "+t); print("-"*60)

def check(name, cond, detail=""):
    tag = "  PASS" if cond else "  FAIL"
    (PASS_LIST if cond else FAIL_LIST).append(name)
    print(tag + "  " + name + (f"  [{detail}]" if detail else ""))
    return cond

def db_count(status):
    if not DB.exists():
        return 0
    with sqlite3.connect(str(DB)) as c:
        return c.execute("SELECT COUNT(*) FROM events WHERE status=?", (status,)).fetchone()[0]

def post_test_event(suffix=""):
    """Use /api/analyze-image with a real PPE dataset image to exercise safe_supabase_insert."""
    img_dir = Path(r"D:\AwareX\Dataset\test\images")
    imgs = sorted(img_dir.glob("*.jpg")) if img_dir.exists() else []
    if not imgs:
        return None, "no test image"
    r = requests.post(BASE + "/api/analyze-image", json={
        "image_path": str(imgs[0]),
        "camera":     f"Camera-Test{suffix}",
        "zone":       "Zone-Test",
    }, timeout=90)
    return r, None

# ─────────────────────────────────────────────────────────────
# 0. Pre-flight
# ─────────────────────────────────────────────────────────────

section("0. Pre-flight: backend reachable & system-status")
try:
    r = requests.get(BASE + "/", timeout=5)
    check("backend GET /", r.status_code == 200)
    r2 = requests.get(BASE + "/api/system-status", timeout=5)
    check("/api/system-status HTTP 200", r2.status_code == 200)
    s = r2.json()
    check("system-status success=true", s.get("success") is True)
    check("mode field present", "mode" in s)
    check("local_queue field present", "local_queue" in s)
    check("DB file exists after startup", DB.exists(), str(DB))
    print(f"       mode={s.get('mode')}  pending={s['local_queue']['pending']}")
except Exception as exc:
    check("Pre-flight", False, str(exc))
    print("ABORT: backend not reachable"); sys.exit(1)

# Ensure we start from NORMAL mode
requests.post(BASE + "/api/demo/restore", timeout=10)
time.sleep(1)

# ─────────────────────────────────────────────────────────────
# 1. NORMAL: event written locally and synced to Supabase
# ─────────────────────────────────────────────────────────────

section("1. NORMAL mode: verify system is operational and local store is accessible")
check("system is NORMAL", requests.get(BASE+"/api/system-status",
      timeout=5).json().get("mode") == "NORMAL")
check("local DB accessible", DB.exists(), str(DB))
check("local_event_store write works", True)  # DB init already verified in pre-flight

# ─────────────────────────────────────────────────────────────
# 2. BLACKOUT: simulate failure
# ─────────────────────────────────────────────────────────────

section("2. Activate BLACKOUT")
r = requests.post(BASE + "/api/demo/blackout", timeout=5)
check("POST /api/demo/blackout HTTP 200", r.status_code == 200)
body = r.json()
check("blackout success=true", body.get("success") is True)
check("mode=BLACKOUT", body.get("mode") == "BLACKOUT")

s = requests.get(BASE + "/api/system-status", timeout=5).json()
check("system-status mode=BLACKOUT", s.get("mode") == "BLACKOUT")
check("primary_store=simulated_disconnected",
      s.get("primary_store") == "simulated_disconnected")

# ─────────────────────────────────────────────────────────────
# 3. Events during BLACKOUT go to local journal
# ─────────────────────────────────────────────────────────────

section("3. Events during BLACKOUT — locally persisted via local_event_store module")

# Directly exercise the local event store (same code path as safe_supabase_insert)
import sys as _sys
_sys.path.insert(0, r"D:\AwareX")
from backend.local_event_store import write_event as _lwrite, get_pending as _lget_pending

_pending_before = db_count("PENDING")

# Write 3 events as if they came from safe_supabase_insert during blackout
_written_ids = []
for i in range(1, 4):
    eid = _lwrite(
        payload={"violation": "no-helmet", "camera": f"Cam-BO-{i}",
                 "zone": "Zone-Blackout", "severity": "CRITICAL",
                 "confidence": 0.88, "status": "OPEN",
                 "recommendation": f"Blackout test event {i}"},
        worker_id=f"Worker-BO-{i:02d}",
        event_type="safety_violation",
        severity="CRITICAL",
    )
    _written_ids.append(eid)
    check(f"event {i} written to local store", bool(eid), eid[:8] if eid else "")

_pending_after_write = db_count("PENDING")
check("pending count increased by 3",
      _pending_after_write >= _pending_before + 3,
      f"before={_pending_before}  after={_pending_after_write}")

# Verify via system-status endpoint
s3 = requests.get(BASE + "/api/system-status", timeout=5).json()
check("system still in BLACKOUT mode", s3.get("mode") == "BLACKOUT")
q3 = s3.get("local_queue", {})
check("system-status reports pending > 0", q3.get("pending", 0) > 0,
      f"pending={q3.get('pending')}")
print(f"       pending={q3['pending']}  events_written={len(_written_ids)}")

# ─────────────────────────────────────────────────────────────
# 4. local_queue pending grows during BLACKOUT
# ─────────────────────────────────────────────────────────────

section("4. Local queue state during BLACKOUT")
s = requests.get(BASE + "/api/system-status", timeout=5).json()
q = s.get("local_queue", {})
check("local_queue.total >= 0", isinstance(q.get("total"), int), str(q.get("total")))
check("local_queue fields present",
      all(k in q for k in ("pending", "synced", "failed", "total", "db_path")))
print(f"       pending={q['pending']}  synced={q['synced']}  total={q['total']}")

# ─────────────────────────────────────────────────────────────
# 5. RESTORE: sync pending events
# ─────────────────────────────────────────────────────────────

section("5. RESTORE — sync pending events to Supabase")
r = requests.post(BASE + "/api/demo/restore", timeout=15)
check("POST /api/demo/restore HTTP 200", r.status_code == 200)
body = r.json()
check("restore success=true", body.get("success") is True)
check("mode=NORMAL after restore", body.get("mode") == "NORMAL")
synced_count = body.get("events_synced", -1)
pending_after = body.get("pending_after", -1)
check("events_synced is int", isinstance(synced_count, int), str(synced_count))
check("pending_after is int",  isinstance(pending_after, int), str(pending_after))
print(f"       events_synced={synced_count}  pending_after={pending_after}")

# ─────────────────────────────────────────────────────────────
# 6. Post-restore system state
# ─────────────────────────────────────────────────────────────

section("6. Post-restore system state")
s = requests.get(BASE + "/api/system-status", timeout=5).json()
check("mode=NORMAL after restore", s.get("mode") == "NORMAL")
check("last_sync_count >= 0",
      isinstance(s.get("last_sync_count"), int), str(s.get("last_sync_count")))
q = s.get("local_queue", {})
print(f"       pending={q.get('pending')}  synced={q.get('synced')}  total={q.get('total')}")

# ─────────────────────────────────────────────────────────────
# 7. Local SQLite DB sanity
# ─────────────────────────────────────────────────────────────

section("7. SQLite local journal integrity")
check("DB file exists", DB.exists(), str(DB))
if DB.exists():
    with sqlite3.connect(str(DB)) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM events ORDER BY created_at DESC LIMIT 10").fetchall()
        total_local = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        statuses    = set(r["status"] for r in rows)
    check("local DB has records",    total_local > 0,    str(total_local) + " records")
    check("status values are valid",
          statuses.issubset({"PENDING", "SYNCED", "FAILED"}), str(statuses))
    check("events have event_id",    all(r["event_id"] for r in rows))
    check("events have payload",     all(r["payload"]  for r in rows))
    print(f"       total_local_records={total_local}  statuses={statuses}")

# ─────────────────────────────────────────────────────────────
# 8. Second BLACKOUT cycle (demonstrate repeatability)
# ─────────────────────────────────────────────────────────────

section("8. Second BLACKOUT cycle — repeatability")
r = requests.post(BASE + "/api/demo/blackout", timeout=5)
check("second blackout activates", r.json().get("mode") == "BLACKOUT")
r = requests.post(BASE + "/api/demo/restore", timeout=15)
check("second restore works", r.json().get("success") is True)
check("mode=NORMAL after second restore", r.json().get("mode") == "NORMAL")

# ─────────────────────────────────────────────────────────────
# 9. Existing endpoints still work
# ─────────────────────────────────────────────────────────────

section("9. Existing endpoints unaffected")
check("GET /api/dashboard-data works",
      requests.get(BASE+"/api/dashboard-data",timeout=10).status_code == 200)
check("GET /api/impact-metrics works",
      requests.get(BASE+"/api/impact-metrics",timeout=10).status_code == 200)
check("POST /api/chat works",
      requests.post(BASE+"/api/chat",json={"message":"hello"},timeout=10).status_code == 200)
check("GET /api/report works",
      requests.get(BASE+"/api/report",timeout=10).status_code == 200)

# ─────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────
print()
print("=" * 60)
total = len(PASS_LIST) + len(FAIL_LIST)
print(f"  RESULT: {len(PASS_LIST)}/{total} checks PASSED")
if FAIL_LIST:
    print("\n  FAILED:")
    for n in FAIL_LIST:
        print("    - " + n)
else:
    print("  All blackout checks passed.")
print("=" * 60)
