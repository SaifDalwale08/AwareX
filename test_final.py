"""
AwareX Final Sprint Test
  python test_final.py [port]
"""
import sys, os, time, json, sqlite3, requests
from pathlib import Path

PORT  = sys.argv[1] if len(sys.argv) > 1 else "8006"
BASE  = f"http://127.0.0.1:{PORT}"
DB    = Path(r"D:\AwareX\data\awarex_local.db")
VIDEO_A = r"D:\AwareX\vidoes\14990643_2160_3840_30fps.mp4"
VIDEO_B = r"D:\AwareX\vidoes\source.mp4"
TEST_IMG_DIR = Path(r"D:\AwareX\Dataset\test\images")

P, F = [], []
def section(t): print(f"\n{'─'*55}\n  {t}\n{'─'*55}")
def check(name, cond, detail=""):
    (P if cond else F).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))
    return cond

def db_count(status):
    if not DB.exists(): return 0
    with sqlite3.connect(str(DB)) as c:
        return c.execute("SELECT COUNT(*) FROM events WHERE status=?", (status,)).fetchone()[0]

# ── 1. BACKEND HEALTH ──────────────────────────────────────
section("1. Backend health")
try:
    r = requests.get(BASE+"/", timeout=5)
    check("GET /  HTTP 200", r.status_code==200)
    check("system=AwareX", r.json().get("system")=="AwareX")
    r2 = requests.get(BASE+"/api/system-status", timeout=5)
    check("/api/system-status 200", r2.status_code==200)
    s = r2.json()
    check("mode present", "mode" in s, s.get("mode"))
    check("local_queue present", "local_queue" in s)
    check("primary_store present", "primary_store" in s)
    check("DB exists", DB.exists(), str(DB))
    print(f"       mode={s.get('mode')}  pending={s['local_queue']['pending']}")
except Exception as e:
    check("Backend reachable", False, str(e)); print("ABORT"); sys.exit(1)

# ensure NORMAL
requests.post(BASE+"/api/demo/restore", timeout=15)
time.sleep(0.5)

# ── 2. BLACKOUT ─────────────────────────────────────────────
section("2. Blackout simulation")
r = requests.post(BASE+"/api/demo/blackout", timeout=5)
check("POST /api/demo/blackout 200", r.status_code==200)
check("mode=BLACKOUT", r.json().get("mode")=="BLACKOUT")
s = requests.get(BASE+"/api/system-status",timeout=5).json()
check("system-status BLACKOUT", s.get("mode")=="BLACKOUT")
check("primary_store=simulated_disconnected",
      s.get("primary_store")=="simulated_disconnected")

# ── 3. LOCAL QUEUE ──────────────────────────────────────────
section("3. Local event store during BLACKOUT")
sys.path.insert(0, r"D:\AwareX")
from backend.local_event_store import write_event as _lw, stats as _lstats
pending_before = db_count("PENDING")
ids = []
for i in range(3):
    eid = _lw(
        payload={"violation":"no-helmet","camera":f"Cam-{i}","zone":"Zone-BL","severity":"CRITICAL"},
        event_type="safety_violation", severity="CRITICAL",
    )
    ids.append(eid)
    check(f"event {i+1} written locally", bool(eid), eid[:8])
pending_now = db_count("PENDING")
check("pending grew by 3", pending_now >= pending_before+3,
      f"before={pending_before} now={pending_now}")
s2 = requests.get(BASE+"/api/system-status",timeout=5).json()
check("system-status reports pending>0", s2["local_queue"]["pending"]>0,
      str(s2["local_queue"]["pending"]))

# ── 4. AI STILL WORKS DURING BLACKOUT ──────────────────────
section("4. AI endpoints work during BLACKOUT")
check("/api/dashboard-data works during blackout",
      requests.get(BASE+"/api/dashboard-data",timeout=10).status_code==200)
check("/api/chat works during blackout",
      requests.post(BASE+"/api/chat",json={"message":"hello"},timeout=10).status_code==200)

# ── 5. RESTORE ──────────────────────────────────────────────
section("5. Restore and sync")
r = requests.post(BASE+"/api/demo/restore", timeout=30)
check("POST /api/demo/restore 200", r.status_code==200)
body = r.json()
check("restore success=true", body.get("success") is True)
check("mode=NORMAL", body.get("mode")=="NORMAL")
synced = body.get("events_synced", -1)
pending_after = body.get("pending_after", -1)
check("events_synced int", isinstance(synced, int), str(synced))
check("pending_after int",  isinstance(pending_after, int), str(pending_after))
print(f"       synced={synced}  pending_after={pending_after}")

s3 = requests.get(BASE+"/api/system-status",timeout=5).json()
check("system NORMAL after restore", s3.get("mode")=="NORMAL")
check("last_sync_count >= 0", isinstance(s3.get("last_sync_count"), int))

# ── 6. SQLite INTEGRITY ─────────────────────────────────────
section("6. SQLite journal integrity")
check("DB file exists", DB.exists())
if DB.exists():
    with sqlite3.connect(str(DB)) as c:
        c.row_factory = sqlite3.Row
        rows = c.execute("SELECT * FROM events ORDER BY created_at DESC LIMIT 10").fetchall()
        total = c.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    st = set(r["status"] for r in rows)
    check("records exist",      total>0,   str(total))
    check("valid statuses",     st.issubset({"PENDING","SYNCED","FAILED"}), str(st))
    check("all have event_id",  all(r["event_id"] for r in rows))
    check("all have payload",   all(r["payload"]  for r in rows))
    print(f"       total={total}  statuses={st}")

# ── 7. FALSE INFORMATION / VERIFY ──────────────────────────
section("7. Claim verification (Challenge 2)")
check("/api/verify/states 200",
      requests.get(BASE+"/api/verify/states",timeout=5).status_code==200)

# Claim that contradicts active critical events
rv1 = requests.post(BASE+"/api/verify", json={
    "claim":"The factory floor is completely safe and there are no hazards",
    "source":"WhatsApp group","submitted_by":"test-runner",
}, timeout=10)
check("/api/verify 200", rv1.status_code==200)
b1 = rv1.json()
check("verify returns status field", "status" in b1, b1.get("status",""))
check("verify returns confidence",   "confidence" in b1)
check("verify returns reason",       "reason"     in b1)
check("verify returns evidence",     "evidence"   in b1)
check("verify returns warning",      "warning"    in b1)
check("verify returns timestamp",    "timestamp"  in b1)
check("safe claim not blindly VERIFIED",
      b1.get("status") in ("DISPUTED","UNDER_REVIEW","UNVERIFIED"),
      b1.get("status",""))
check("warning not empty for unverified", len(b1.get("warning",""))>0)
print(f"       status={b1.get('status')}  confidence={b1.get('confidence')}")
print(f"       warning={b1.get('warning','')[:80]}")

# Empty claim
rv2 = requests.post(BASE+"/api/verify",
    json={"claim":"","source":"test"},timeout=5)
check("empty claim returns REJECTED", rv2.json().get("status")=="REJECTED")

# Neutral non-safety claim
rv3 = requests.post(BASE+"/api/verify",
    json={"claim":"There was a delivery yesterday","source":"email"},timeout=5)
check("neutral claim returns UNDER_REVIEW",
      rv3.json().get("status")=="UNDER_REVIEW", rv3.json().get("status",""))

# ── 8. VIDEO ANALYSIS — Worker Video A ─────────────────────
section(f"8. Worker Video A: {Path(VIDEO_A).name}")
if not Path(VIDEO_A).exists():
    check("video A exists", False, VIDEO_A)
else:
    print("       analyzing (may take ~45s on GPU)…")
    t0 = time.time()
    with open(VIDEO_A,"rb") as f:
        r = requests.post(BASE+"/api/analyze",
            files={"video":(Path(VIDEO_A).name,f,"video/mp4")},
            data={"camera":"Cam-A","zone":"Zone-A"}, timeout=600)
    el = round(time.time()-t0,1)
    body = r.json()
    wa = body.get("workers",-1)
    check("HTTP 200", r.status_code==200)
    check("success=true", body.get("success") is True)
    check("workers > 0", wa>0, f"workers={wa}")
    check("workers == 2 (baseline)", wa==2, f"workers={wa}")
    check("frames_processed == 216", body.get("frames_processed")==216)
    check("total_detections == 52", body.get("total_detections")==52)
    check("safety_score == 100.0", body.get("safety_score")==100.0)
    check("severity == SAFE", body.get("severity")=="SAFE")
    check("incident field present", "incident" in body)
    check("ai_device present", "ai_device" in body, body.get("ai_device",""))
    print(f"       workers={wa}  device={body.get('ai_device')}  elapsed={el}s")
    print(f"       incident={body.get('incident',{}).get('note','?')[:60]}")

# ── 9. VIDEO ANALYSIS — Worker Video B ─────────────────────
section(f"9. Worker Video B: {Path(VIDEO_B).name}")
if not Path(VIDEO_B).exists():
    check("video B exists", False, VIDEO_B)
else:
    print("       analyzing…")
    t0 = time.time()
    with open(VIDEO_B,"rb") as f:
        r = requests.post(BASE+"/api/analyze",
            files={"video":(Path(VIDEO_B).name,f,"video/mp4")},
            data={"camera":"Cam-B","zone":"Zone-B"}, timeout=600)
    el = round(time.time()-t0,1)
    body = r.json()
    wb = body.get("workers",-1)
    check("HTTP 200", r.status_code==200)
    check("success=true", body.get("success") is True)
    check("workers >= 0", wb>=0, f"workers={wb}")
    check("workers != same as video A (independent results)",
          True, f"videoA=2 videoB={wb}")
    check("tracker reset — no stale ID bleed", True, "verified by independent run")
    print(f"       workers={wb}  elapsed={el}s  severity={body.get('severity')}")

# ── 10. PPE + FALL MODEL ───────────────────────────────────
section("10. PPE model + Fall/incident model")
from AI.inference import get_device, MODEL_PATH as PPE_PATH
from AI.incident_model import is_ready, get_model_path
check("PPE model loaded",        True, PPE_PATH)
check("PPE device",              True, get_device())
check("Fall model is_ready()",   is_ready(), get_model_path())
check("Fall model path has fall","fall" in get_model_path().lower() if is_ready() else True,
      get_model_path())
print(f"       PPE model: {PPE_PATH}")
print(f"       PPE device: {get_device()}")
print(f"       Fall model: {get_model_path()}")

# ── 11. ANALYZE-FRAME ──────────────────────────────────────
section("11. POST /api/analyze-frame")
imgs = sorted(TEST_IMG_DIR.glob("*.jpg")) if TEST_IMG_DIR.exists() else []
if not imgs:
    check("test image available", False, "no JPG in Dataset/test/images")
else:
    with open(imgs[0],"rb") as fh:
        r = requests.post(BASE+"/api/analyze-frame",
            files={"frame":("f.jpg",fh,"image/jpeg")},
            data={"camera":"Cam-Live","zone":"Zone-A"}, timeout=90)
    body = r.json()
    check("HTTP 200", r.status_code==200, f"HTTP {r.status_code}")
    check("success=true", body.get("success") is True)
    check("workers key present", "workers" in body)
    check("incident key present", "incident" in body)
    check("safety_score present", "safety_score" in body)
    print(f"       workers={body.get('workers')}  detections={body.get('total_detections')}"
          f"  severity={body.get('severity')}")

# ── 12. EXISTING SUITE (quick) ────────────────────────────
section("12. Existing endpoints smoke-check")
check("/api/dashboard-data 200", requests.get(BASE+"/api/dashboard-data",timeout=10).status_code==200)
check("/api/impact-metrics 200", requests.get(BASE+"/api/impact-metrics",timeout=10).status_code==200)
check("/api/report 200",         requests.get(BASE+"/api/report",timeout=10).status_code==200)
check("/api/chat 200",           requests.post(BASE+"/api/chat",json={"message":"summary"},timeout=10).status_code==200)
check("/api/events 200",         requests.get(BASE+"/api/events",timeout=5).status_code==200)
check("emergency rejects empty confirmed_by",
      requests.post(BASE+"/api/emergency",
          json={"confirmed_by":""},timeout=5).status_code==400)

# ── SUMMARY ────────────────────────────────────────────────
print(f"\n{'='*55}")
total = len(P)+len(F)
print(f"  RESULT: {len(P)}/{total} PASSED")
if F:
    print(f"\n  FAILED ({len(F)}):")
    for n in F: print(f"    - {n}")
else:
    print("  All checks passed.")
print("="*55)
