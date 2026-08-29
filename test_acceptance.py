"""
AwareX Acceptance Test
======================
Run with:
    cd D:\AwareX
    .\.venv\Scripts\python.exe test_acceptance.py
"""

import time
import requests

BASE = "http://127.0.0.1:8003"
VIDEO = r"D:\AwareX\vidoes\14990643_2160_3840_30fps.mp4"

PASS_LIST = []
FAIL_LIST = []


def check(name, condition, detail=""):
    if condition:
        PASS_LIST.append(name)
        tag = "  PASS"
    else:
        FAIL_LIST.append(name)
        tag = "  FAIL"
    suffix = "  [" + str(detail) + "]" if detail else ""
    print(tag + "  " + name + suffix)


def section(title):
    print()
    print("-" * 60)
    print("  " + title)
    print("-" * 60)


# ============================================================
# 1. Root endpoint
# ============================================================
section("1. GET /")
try:
    r = requests.get(BASE + "/", timeout=10)
    body = r.json()
    check("HTTP 200", r.status_code == 200, "HTTP " + str(r.status_code))
    check("system == AwareX", body.get("system") == "AwareX", str(body.get("system")))
    check("status == online", body.get("status") == "online", str(body.get("status")))
    check("version present", "version" in body, str(body.get("version")))
except Exception as exc:
    check("Root endpoint reachable", False, str(exc))


# ============================================================
# 2. Dashboard data  (Supabase)
# ============================================================
section("2. GET /api/dashboard-data")
try:
    r = requests.get(BASE + "/api/dashboard-data", timeout=15)
    body = r.json()
    check("HTTP 200", r.status_code == 200, "HTTP " + str(r.status_code))
    check("success == true", body.get("success") is True)
    check("events is a list", isinstance(body.get("events"), list),
          str(len(body.get("events", []))) + " events")
    check("total_events is int", isinstance(body.get("total_events"), int),
          str(body.get("total_events")))
    check("critical_events is int", isinstance(body.get("critical_events"), int),
          str(body.get("critical_events")))
except Exception as exc:
    check("Dashboard data reachable", False, str(exc))


# ============================================================
# 3. Chatbot
# ============================================================
section("3. POST /api/chat")
try:
    payload = {"message": "Give me a safety summary"}
    r = requests.post(BASE + "/api/chat", json=payload, timeout=15)
    body = r.json()
    check("HTTP 200", r.status_code == 200, "HTTP " + str(r.status_code))
    check("success == true", body.get("success") is True)
    answer = body.get("answer", "")
    check("answer is non-empty string", isinstance(answer, str) and len(answer) > 10,
          str(len(answer)) + " chars")
    check("source is deterministic or openai",
          body.get("source") in ("deterministic", "openai"),
          str(body.get("source")))
    check("data_summary present", isinstance(body.get("data_summary"), dict))
    print("       answer preview: " + answer[:120].replace("\n", " "))
except Exception as exc:
    check("Chatbot reachable", False, str(exc))


# ============================================================
# 4. Report generation
# ============================================================
section("4. GET /api/report?format=html")
try:
    r = requests.get(BASE + "/api/report?format=html", timeout=15)
    check("HTTP 200", r.status_code == 200, "HTTP " + str(r.status_code))
    ct = r.headers.get("content-type", "")
    check("content-type is text/html", "text/html" in ct, ct)
    cd = r.headers.get("content-disposition", "")
    check("content-disposition attachment", "attachment" in cd, cd)
    html = r.text
    check("contains AwareX title", "AwareX" in html)
    check("contains Safety Score", "Safety Score" in html)
    check("contains Executive Summary", "Executive Summary" in html)
    check("non-trivial size > 2000 chars", len(html) > 2000, str(len(html)) + " chars")
except Exception as exc:
    check("Report endpoint reachable", False, str(exc))


# ============================================================
# 5. Notification endpoint (mock mode — no real credentials)
# ============================================================
section("5. POST /api/notify")
try:
    payload = {
        "violation": "no-helmet",
        "worker_id": "Worker-01",
        "zone": "Zone-A",
        "camera": "Camera-01",
        "severity": "CRITICAL",
        "confidence": 0.91,
        "recommendation": "Immediate PPE compliance intervention recommended."
    }
    r = requests.post(BASE + "/api/notify", json=payload, timeout=15)
    body = r.json()
    check("HTTP 200", r.status_code == 200, "HTTP " + str(r.status_code))
    check("success == true", body.get("success") is True)
    notif = body.get("notification", {})
    check("notification object present", isinstance(notif, dict))
    check("providers list present", isinstance(notif.get("providers"), list),
          str(len(notif.get("providers", []))) + " providers")
    check("message_preview present", isinstance(notif.get("message_preview"), str))
    check("mock_mode == true (no credentials set)", notif.get("mock_mode") is True)
    check("timestamp present", "timestamp" in notif)
    preview = notif.get("message_preview", "")
    print("       message preview: " + preview[:100].replace("\n", " | "))
except Exception as exc:
    check("Notify endpoint reachable", False, str(exc))


# ============================================================
# 6. Video analysis
# ============================================================
section("6. POST /api/analyze  (4K video — ~4 min on CPU)")
print("       video: " + VIDEO)
print("       waiting...")
t0 = time.time()
try:
    with open(VIDEO, "rb") as fh:
        r = requests.post(
            BASE + "/api/analyze",
            files={"video": ("14990643_2160_3840_30fps.mp4", fh, "video/mp4")},
            data={"camera": "Camera-01", "zone": "Zone-A"},
            timeout=600
        )
    elapsed = round(time.time() - t0, 1)
    print("       completed in " + str(elapsed) + "s")

    body = r.json()

    # --- HTTP / top-level ---
    check("HTTP 200", r.status_code == 200, "HTTP " + str(r.status_code))
    check("success == true", body.get("success") is True)

    # --- Worker count (the primary fix) ---
    workers = body.get("workers", -1)
    check("workers > 0 (real tracked count)", workers > 0, "workers=" + str(workers))
    check("workers == 2 (known video)", workers == 2, "workers=" + str(workers))

    # --- Frame counts ---
    fp = body.get("frames_processed", -1)
    check("frames_processed == 216", fp == 216, "frames_processed=" + str(fp))

    sf = body.get("sampled_frames", -1)
    check("sampled_frames == 22", sf == 22, "sampled_frames=" + str(sf))

    # --- PPE detections ---
    td = body.get("total_detections", -1)
    check("total_detections == 52", td == 52, "total_detections=" + str(td))

    # --- Safety outcome ---
    score = body.get("safety_score", -1)
    check("safety_score == 100.0", score == 100.0, "safety_score=" + str(score))

    sev = body.get("severity", "")
    check("severity == SAFE", sev == "SAFE", "severity=" + str(sev))

    violations = body.get("violations", [])
    check("violations count == 0", len(violations) == 0,
          "violations=" + str(len(violations)))

    # --- Workers detail ---
    wd = body.get("workers_detail", [])
    check("workers_detail is non-empty list", isinstance(wd, list) and len(wd) > 0,
          str(len(wd)) + " workers in detail")
    if wd:
        w0 = wd[0]
        check("first worker has id field", "id" in w0, str(w0.get("id", "")))
        check("first worker has ppe dict", isinstance(w0.get("ppe"), dict))
        check("first worker has risk field", "risk" in w0, str(w0.get("risk", "")))
        check("first worker has zone field", "zone" in w0, str(w0.get("zone", "")))
        print("       Worker-01 detail: id=" + str(w0.get("id")) +
              "  risk=" + str(w0.get("risk")) +
              "  ppe=" + str(w0.get("ppe")))
    if len(wd) > 1:
        w1 = wd[1]
        print("       Worker-02 detail: id=" + str(w1.get("id")) +
              "  risk=" + str(w1.get("risk")) +
              "  ppe=" + str(w1.get("ppe")))

    # --- Recommendations ---
    recs = body.get("recommendations", [])
    check("recommendations is non-empty list", isinstance(recs, list) and len(recs) > 0,
          str(len(recs)) + " recommendation(s)")
    if recs:
        check("first recommendation is a string", isinstance(recs[0], str))
        print("       recommendation: " + str(recs[0])[:80])

    # --- Stored events ---
    stored = body.get("stored_events", [])
    check("stored_events is a list", isinstance(stored, list),
          str(len(stored)) + " stored")

    # --- Video metadata ---
    vm = body.get("video", {})
    check("video.name present", isinstance(vm.get("name"), str))
    check("video.fps > 0", (vm.get("fps") or 0) > 0, "fps=" + str(vm.get("fps")))
    check("video.frames > 0", (vm.get("frames") or 0) > 0,
          "frames=" + str(vm.get("frames")))

except FileNotFoundError:
    check("Video file found", False, "Not found: " + VIDEO)
except Exception as exc:
    check("Video analysis completed", False, str(exc))


# ============================================================
# Summary
# ============================================================
print()
print("=" * 60)
total = len(PASS_LIST) + len(FAIL_LIST)
print("  RESULT: " + str(len(PASS_LIST)) + "/" + str(total) + " checks PASSED")
if FAIL_LIST:
    print()
    print("  FAILED:")
    for name in FAIL_LIST:
        print("    - " + name)
else:
    print("  All checks passed.")
print("=" * 60)
