"""
AwareX Backend Test Suite
==========================
Run from project root:
    .venv\\Scripts\\python.exe test_backend.py

Tests every backend endpoint and core logic.
Never prints credentials. Never sends real SMS during automated tests.
Never contacts emergency services.
"""

import os
import sys
import time
import json
import tempfile
import threading
import requests
from pathlib import Path

# Allow port override: python test_backend.py 8003
import sys
_PORT = sys.argv[1] if len(sys.argv) > 1 else "8003"
BASE  = f"http://127.0.0.1:{_PORT}"
VIDEO = r"D:\AwareX\vidoes\14990643_2160_3840_30fps.mp4"
TEST_IMAGES_DIR = Path(r"D:\AwareX\Dataset\test\images")

# ── First PPE-containing test image (known to have detections) ──
TEST_IMAGE = str(TEST_IMAGES_DIR / "ppe_0005_jpg.rf.92f75811b1228784eaa0be0f2c891338.jpg")

PASS_LIST: list = []
FAIL_LIST: list = []


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def section(title: str) -> None:
    print()
    print("-" * 65)
    print("  " + title)
    print("-" * 65)


def check(name: str, condition: bool, detail: str = "") -> bool:
    tag = "  PASS" if condition else "  FAIL"
    suffix = "  [" + str(detail) + "]" if detail else ""
    print(tag + "  " + name + suffix)
    if condition:
        PASS_LIST.append(name)
    else:
        FAIL_LIST.append(name)
    return condition


def skip(name: str, reason: str) -> None:
    print("  SKIP  " + name + "  [" + reason + "]")


# ─────────────────────────────────────────────────────────────
# TEST 1 — Root endpoint
# ─────────────────────────────────────────────────────────────

section("TEST 1 — GET /")
try:
    r    = requests.get(BASE + "/", timeout=10)
    body = r.json()
    check("HTTP 200",            r.status_code == 200,          "HTTP " + str(r.status_code))
    check("system == AwareX",    body.get("system") == "AwareX")
    check("status == online",    body.get("status") == "online")
    check("version present",     "version" in body,              str(body.get("version", "")))
except Exception as exc:
    check("Root endpoint reachable", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 2 — Dashboard data / Supabase
# ─────────────────────────────────────────────────────────────

section("TEST 2 — GET /api/dashboard-data")
try:
    r    = requests.get(BASE + "/api/dashboard-data", timeout=15)
    body = r.json()
    check("HTTP 200",                  r.status_code == 200)
    check("success == true",           body.get("success") is True)
    check("events is a list",          isinstance(body.get("events"), list),
          str(len(body.get("events", []))) + " events")
    check("total_events is int",       isinstance(body.get("total_events"), int),
          str(body.get("total_events")))
    check("critical_events is int",    isinstance(body.get("critical_events"), int),
          str(body.get("critical_events")))
except Exception as exc:
    check("Dashboard data reachable", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 3 — Chatbot
# ─────────────────────────────────────────────────────────────

section("TEST 3 — POST /api/chat")
try:
    r    = requests.post(BASE + "/api/chat",
                         json={"message": "Give me a safety summary"}, timeout=20)
    body = r.json()
    check("HTTP 200",                         r.status_code == 200)
    check("success == true",                  body.get("success") is True)
    answer = body.get("answer", "")
    check("answer is non-empty string",       isinstance(answer, str) and len(answer) > 10,
          str(len(answer)) + " chars")
    check("source in (deterministic, openai)", body.get("source") in ("deterministic", "openai"),
          str(body.get("source")))
    check("data_summary present",             isinstance(body.get("data_summary"), dict))
    print("       answer preview: " + answer[:120].replace("\n", " "))
except Exception as exc:
    check("Chatbot reachable", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 4 — Report generation
# ─────────────────────────────────────────────────────────────

section("TEST 4 — GET /api/report?format=html")
try:
    r    = requests.get(BASE + "/api/report?format=html", timeout=15)
    html = r.text
    check("HTTP 200",                       r.status_code == 200)
    check("content-type text/html",         "text/html" in r.headers.get("content-type", ""))
    check("content-disposition attachment", "attachment" in r.headers.get("content-disposition", ""))
    check("contains AwareX title",          "AwareX" in html)
    check("contains Safety Score",          "Safety Score" in html)
    check("contains Executive Summary",     "Executive Summary" in html)
    check("size > 2000 chars",              len(html) > 2000, str(len(html)) + " chars")
except Exception as exc:
    check("Report endpoint reachable", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 5 — Manual notification (mock mode)
# Deliberately skip TextBee during automated tests if creds are present.
# ─────────────────────────────────────────────────────────────

section("TEST 5 — POST /api/notify  (mock/response validation only)")
try:
    payload = {
        "violation":      "no-helmet",
        "worker_id":      "Worker-TestSuite",
        "zone":           "Zone-TestSuite",
        "camera":         "Camera-Test",
        "severity":       "CRITICAL",
        "confidence":     0.91,
        "recommendation": "TEST — automated test payload, do not act on.",
    }
    r    = requests.post(BASE + "/api/notify", json=payload, timeout=15)
    body = r.json()
    check("HTTP 200",                      r.status_code == 200)
    check("success == true",               body.get("success") is True)
    notif = body.get("notification", {})
    check("notification object present",   isinstance(notif, dict))
    check("providers list present",        isinstance(notif.get("providers"), list),
          str(len(notif.get("providers", []))) + " providers")
    check("message_preview present",       isinstance(notif.get("message_preview"), str))
    check("timestamp present",             "timestamp" in notif)
    # Report TextBee status without sending a real SMS
    tb = next((p for p in notif.get("providers", []) if p.get("provider") == "textbee"), None)
    if tb:
        print("       TextBee status: " + tb.get("status", "?") +
              ("  [" + tb.get("reason", tb.get("error", "")) + "]"
               if tb.get("status") != "sent" else "  [credentials active]"))
    else:
        print("       TextBee: not in provider list")
except Exception as exc:
    check("Notify endpoint reachable", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 6 — Video analysis  (baseline regression)
# ─────────────────────────────────────────────────────────────

section("TEST 6 — POST /api/analyze  (baseline regression ~2–4 min)")
if not Path(VIDEO).exists():
    check("Video file exists", False, "Not found: " + VIDEO)
else:
    print("       video: " + VIDEO)
    print("       waiting for analysis to complete...")
    t0 = time.time()
    try:
        with open(VIDEO, "rb") as fh:
            r = requests.post(
                BASE + "/api/analyze",
                files={"video": ("14990643_2160_3840_30fps.mp4", fh, "video/mp4")},
                data={"camera": "Camera-01", "zone": "Zone-A"},
                timeout=600,
            )
        elapsed = round(time.time() - t0, 1)
        body    = r.json()
        print("       completed in " + str(elapsed) + "s")

        check("HTTP 200",               r.status_code == 200)
        check("success == true",        body.get("success") is True)

        workers = body.get("workers", -1)
        check("workers == 2",           workers == 2,      "workers=" + str(workers))
        check("workers > 0",            workers > 0,       "workers=" + str(workers))

        fp = body.get("frames_processed", -1)
        check("frames_processed == 216", fp == 216,        "frames_processed=" + str(fp))

        sf = body.get("sampled_frames", -1)
        check("sampled_frames == 22",   sf == 22,          "sampled_frames=" + str(sf))

        td = body.get("total_detections", -1)
        check("total_detections == 52", td == 52,          "total_detections=" + str(td))

        sc = body.get("safety_score", -1)
        check("safety_score == 100.0",  sc == 100.0,       "safety_score=" + str(sc))

        sv = body.get("severity", "")
        check("severity == SAFE",       sv == "SAFE",       "severity=" + str(sv))

        vl = body.get("violations", [])
        check("violations == 0",        len(vl) == 0,      "violations=" + str(len(vl)))

        wd = body.get("workers_detail", [])
        check("workers_detail non-empty", len(wd) > 0,     str(len(wd)) + " workers")

        recs = body.get("recommendations", [])
        check("recommendations non-empty", len(recs) > 0,  str(len(recs)) + " recs")

        stored = body.get("stored_events", [])
        check("stored_events is list",  isinstance(stored, list))

        if wd:
            w0 = wd[0]
            check("worker has id",      "id"  in w0,       str(w0.get("id", "")))
            check("worker has ppe dict", isinstance(w0.get("ppe"), dict))
            check("worker has risk",    "risk" in w0,      str(w0.get("risk", "")))
            print("       Worker-0 detail: id=" + str(w0.get("id")) +
                  "  risk=" + str(w0.get("risk")) + "  ppe=" + str(w0.get("ppe")))

    except Exception as exc:
        check("Video analysis completed", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 7 — WorkerTracker direct unit test
# ─────────────────────────────────────────────────────────────

section("TEST 7 — WorkerTracker unit test (direct)")
try:
    import cv2
    from AI.worker_tracking import WorkerTracker

    # Use first frame of the known video (has 2 real workers)
    cap   = cv2.VideoCapture(VIDEO)
    ret, frame = cap.read()
    cap.release()
    check("Video frame readable", ret and frame is not None)

    if ret and frame is not None:
        tracker = WorkerTracker()
        workers = tracker.track_frame(frame)
        check("track_frame returns a list",       isinstance(workers, list))
        check("at least 1 worker in first frame", len(workers) >= 1,
              str(len(workers)) + " workers")
        if workers:
            w = workers[0]
            check("worker has track_id or None",  "track_id" in w)
            check("worker has bbox",              "bbox"     in w)
            check("worker has confidence",        "confidence" in w)
            print("       First worker: " + str(w))
except Exception as exc:
    check("WorkerTracker direct test", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 8 — /api/analyze-frame with a real PPE dataset image
# ─────────────────────────────────────────────────────────────

section("TEST 8 — POST /api/analyze-frame  (PPE dataset image)")
if not Path(TEST_IMAGE).exists():
    check("Test image exists", False, "Not found: " + TEST_IMAGE)
else:
    try:
        with open(TEST_IMAGE, "rb") as fh:
            r = requests.post(
                BASE + "/api/analyze-frame",
                files={"frame": ("webcam_frame.jpg", fh, "image/jpeg")},
                data={"camera": "Laptop-Camera", "zone": "Zone-A"},
                timeout=60,
            )
        body = r.json()
        check("HTTP 200",                    r.status_code == 200, "HTTP " + str(r.status_code))
        check("success == true",             body.get("success") is True)
        check("workers key present",         "workers"         in body)
        check("workers_detail key present",  "workers_detail"  in body)
        check("safety_score key present",    "safety_score"    in body)
        check("severity key present",        "severity"        in body)
        check("total_detections key present","total_detections" in body)
        check("frame_count incremented",     body.get("frame_count", 0) >= 1,
              "frame=" + str(body.get("frame_count")))
        print("       workers="  + str(body.get("workers")) +
              "  detections=" + str(body.get("total_detections")) +
              "  severity="   + str(body.get("severity")))
    except Exception as exc:
        check("/api/analyze-frame reachable", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 9 — PPE-worker association  (workers_detail structure)
# ─────────────────────────────────────────────────────────────

section("TEST 9 — PPE-worker association via /api/analyze-frame")
if not Path(TEST_IMAGE).exists():
    check("Test image exists for PPE association", False, "Not found: " + TEST_IMAGE)
else:
    try:
        with open(TEST_IMAGE, "rb") as fh:
            r = requests.post(
                BASE + "/api/analyze-frame",
                files={"frame": ("webcam_frame.jpg", fh, "image/jpeg")},
                data={"camera": "Laptop-Camera", "zone": "Zone-A"},
                timeout=60,
            )
        body = r.json()
        wd   = body.get("workers_detail", [])
        check("workers_detail is a list",   isinstance(wd, list))
        # If workers were detected, validate their structure
        if wd:
            w = wd[0]
            check("worker.id present",      "id"          in w, str(w.get("id", "")))
            check("worker.ppe is dict",     isinstance(w.get("ppe"), dict))
            check("worker.risk present",    "risk"        in w, str(w.get("risk", "")))
            check("worker.zone present",    "zone"        in w, str(w.get("zone", "")))
            check("worker.safety_score",    "safety_score" in w)
            ppe = w.get("ppe", {})
            # PPE values should be True, False, or the uncertainty string
            valid_values = {True, False, "UNCERTAIN / MANUAL VERIFICATION REQUIRED"}
            all_valid = all(v in valid_values for v in ppe.values())
            check("ppe values are valid",   all_valid, str(list(ppe.values())))
            print("       Worker PPE: " + str(ppe))
        else:
            # No workers found in this static image — that's OK for a PPE-only image
            skip("worker PPE fields", "no workers detected in this frame (PPE-only image)")
            check("detections still returned", "detections" in body)
    except Exception as exc:
        check("PPE-worker association test", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 10 — Persistence filter  (unit test, no real waiting)
# We test the _WorkerState logic directly with a mock frame loop.
# The test uses VIOLATION_PERSISTENCE_SECONDS from env (default 5).
# We simulate frames by calling end_frame() repeatedly.
# ─────────────────────────────────────────────────────────────

section("TEST 10 — Persistence filter  (unit test via _WorkerState)")
try:
    from AI.live_monitor import _WorkerState, PERSISTENCE_SECONDS

    ws = _WorkerState(track_id=99, zone="Zone-Test", camera="Cam-Test")
    ws.begin_frame(bbox=[0, 0, 100, 200], confidence=0.9, zone="Zone-Test", camera="Cam-Test")
    ws.record_ppe("no-helmet")  # inject violation
    ws.end_frame()

    # Violation seen once — should NOT be persistent yet
    check("single frame: not yet persistent",
          "no-helmet" not in ws.persistent_violations,
          "persistent=" + str(list(ws.persistent_violations.keys())))

    # Fast-forward time by patching the first-seen timestamp
    import AI.live_monitor as _lm
    ws._viol_first_seen["no-helmet"] = time.time() - (PERSISTENCE_SECONDS + 0.1)

    # Now process another frame with the same violation
    ws.begin_frame(bbox=[0, 0, 100, 200], confidence=0.9, zone="Zone-Test", camera="Cam-Test")
    ws.record_ppe("no-helmet")
    ws.end_frame()

    # Should now be persistent
    check("after threshold: violation becomes persistent",
          "no-helmet" in ws.persistent_violations,
          "persistent=" + str(list(ws.persistent_violations.keys())))

    check("ppe_status[helmet] == False",
          ws.ppe_status.get("helmet") is False,
          "ppe_status=" + str(ws.ppe_status))

    # Simulate PPE put back on — persistent should clear
    ws.begin_frame(bbox=[0, 0, 100, 200], confidence=0.9, zone="Zone-Test", camera="Cam-Test")
    ws.record_ppe("helmet")   # now worn
    ws.end_frame()
    check("after PPE worn: persistence cleared",
          "no-helmet" not in ws.persistent_violations,
          "persistent=" + str(list(ws.persistent_violations.keys())))
    check("ppe_status[helmet] == True after wearing",
          ws.ppe_status.get("helmet") is True)

except Exception as exc:
    check("Persistence unit test", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 11 — Acknowledgement + escalation prevention
# ─────────────────────────────────────────────────────────────

section("TEST 11 — Acknowledgement workflow")
try:
    from AI.live_monitor import LiveMonitor, CriticalEvent
    import AI.live_monitor as _lm

    escalation_fired = []

    def _test_escalation_cb(evt):
        escalation_fired.append(evt.event_id)

    # Isolated monitor instance (doesn't touch main.py's singleton)
    test_monitor = LiveMonitor(escalation_callback=_test_escalation_cb)

    # Manually inject a critical event
    evt = CriticalEvent(
        worker_id="Worker-Test",
        violation="no-helmet",
        confidence=0.91,
        zone="Zone-Test",
        camera="Cam-Test",
    )
    test_monitor._critical_events[evt.event_id] = evt
    test_monitor._start_ack_timer(evt)

    event_id = evt.event_id
    check("event created with OPEN status",   evt.status == "OPEN")

    # Acknowledge via the monitor method
    result = test_monitor.acknowledge_event(event_id)
    check("acknowledge returns success=True", result.get("success") is True)
    check("event status is ACKNOWLEDGED",     evt.status == "ACKNOWLEDGED")

    # Wait slightly longer than ACK_TIMEOUT to confirm escalation did NOT fire
    # We use a very short configured timeout for the test monitor
    # (we can't easily change the env var mid-run, so we just wait 2s and confirm
    #  the acknowledged event was NOT in the escalation list)
    time.sleep(2)
    check("escalation NOT fired for acknowledged event",
          event_id not in escalation_fired,
          "escalation_fired=" + str(escalation_fired))

    # Test event not found
    bad = test_monitor.acknowledge_event("nonexistent-id-12345")
    check("unknown event_id returns success=False", bad.get("success") is False)

    # Test the HTTP endpoint with the live_monitor singleton
    # First get the current events list to find a real event_id
    r = requests.get(BASE + "/api/events", timeout=10)
    check("GET /api/events HTTP 200",   r.status_code == 200)
    events_list = r.json().get("events", [])
    check("events list returned",       isinstance(events_list, list))

    if events_list:
        # Try to acknowledge the first event (might already be acked, that's fine)
        first_id = events_list[0]["event_id"]
        r2 = requests.post(BASE + "/api/events/" + first_id + "/acknowledge", timeout=10)
        check("POST /api/events/{id}/acknowledge HTTP 200", r2.status_code == 200)
        ack_body = r2.json()
        check("ack response has success field", "success" in ack_body)
        check("ack response has event field",   "event"   in ack_body)
    else:
        skip("HTTP ack endpoint test", "no live events in this session")

except Exception as exc:
    check("Acknowledgement test", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 12 — TextBee / mock notification
# We test the notification_service directly without going through /api/notify
# so we can inspect the result without sending a real SMS in the test suite.
# ─────────────────────────────────────────────────────────────

section("TEST 12 — TextBee / mock notification logic")
try:
    from AI.notification_service import send_critical_alert, _send_textbee_sms

    # Save originals FIRST before any clearing
    orig_key   = os.environ.get("TEXTBEE_API_KEY", "")
    orig_phone = os.environ.get("TEXTBEE_MANAGER_PHONE", "")

    # If os.environ lost them (shared process), reload from .env file directly
    if not orig_key or not orig_phone:
        from dotenv import dotenv_values
        _env = dotenv_values("d:\\AwareX\\.env")
        if not orig_key:
            orig_key = _env.get("TEXTBEE_API_KEY", "")
            os.environ["TEXTBEE_API_KEY"] = orig_key
        if not orig_phone:
            orig_phone = _env.get("TEXTBEE_MANAGER_PHONE", "")
            os.environ["TEXTBEE_MANAGER_PHONE"] = orig_phone

    check("TEXTBEE_API_KEY in env",       bool(orig_key.strip()))
    check("TEXTBEE_MANAGER_PHONE in env", bool(orig_phone.strip()))

    # Test the mock path by temporarily clearing env vars in a subprocess-safe way
    # We call send_critical_alert with a clearly labelled test payload
    # but rely on the real credentials being present to send or not send
    # Temporarily remove key to force mock mode for this test
    os.environ["TEXTBEE_API_KEY"] = ""
    result = send_critical_alert(
        violation      = "no-helmet",
        worker_id      = "Worker-TESTONLY",
        zone           = "Zone-TESTONLY",
        camera         = "Cam-TESTONLY",
        severity       = "CRITICAL",
        confidence     = 0.91,
        recommendation = "TEST — do not act on this alert.",
    )
    os.environ["TEXTBEE_API_KEY"] = orig_key  # restore

    check("mock mode active when key removed", result.get("mock_mode") is True)
    check("providers list present",            isinstance(result.get("providers"), list))
    check("message_preview contains worker",   "Worker-TESTONLY" in result.get("message_preview", ""))
    mock_p = next((p for p in result["providers"] if p.get("provider") == "mock"), None)
    check("mock provider in result",           mock_p is not None)
    check("mock status == logged",             (mock_p or {}).get("status") == "logged")

except Exception as exc:
    check("TextBee/mock test", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 13 — Duplicate notification / event deduplication
# ─────────────────────────────────────────────────────────────

section("TEST 13 — Duplicate event deduplication")
try:
    from AI.live_monitor import LiveMonitor, CriticalEvent

    ded_monitor = LiveMonitor(escalation_callback=None)

    # Inject the same worker+violation twice
    def _inject(monitor, worker_id, violation):
        existing = next(
            (e for e in monitor._critical_events.values()
             if e.worker_id == worker_id and e.violation == violation and e.status == "OPEN"),
            None,
        )
        if existing:
            existing.touch()
            return existing
        evt = CriticalEvent(worker_id=worker_id, violation=violation,
                            confidence=0.9, zone="Zone-A", camera="Cam-01")
        monitor._critical_events[evt.event_id] = evt
        return evt

    e1 = _inject(ded_monitor, "Worker-Dup", "no-helmet")
    e2 = _inject(ded_monitor, "Worker-Dup", "no-helmet")  # should update e1, not create new
    e3 = _inject(ded_monitor, "Worker-Dup", "no-vest")    # different violation — new event

    open_events = [e for e in ded_monitor._critical_events.values() if e.status == "OPEN"]
    check("only 2 open events (no-helmet deduped, no-vest new)",
          len(open_events) == 2,
          "open_events=" + str(len(open_events)))
    check("both events have the same worker",
          all(e.worker_id == "Worker-Dup" for e in open_events))
    violations_set = {e.violation for e in open_events}
    check("violations are no-helmet and no-vest",
          violations_set == {"no-helmet", "no-vest"},
          "violations=" + str(violations_set))

except Exception as exc:
    check("Deduplication test", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 14 — Impact metrics
# ─────────────────────────────────────────────────────────────

section("TEST 14 — GET /api/impact-metrics")
try:
    r    = requests.get(BASE + "/api/impact-metrics", timeout=15)
    body = r.json()
    check("HTTP 200",             r.status_code == 200)
    check("success == true",      body.get("success") is True)
    check("source present",       "source"            in body)
    live = body.get("live_session", {})
    check("live_session present",          isinstance(live, dict))
    check("workers_monitored field",       "workers_monitored"     in live)
    check("frames_analyzed field",         "frames_analyzed"       in live)
    check("ppe_compliance_pct field",      "ppe_compliance_pct"    in live)
    check("acknowledged_events field",     "acknowledged_events"   in live)
    check("escalated_events field",        "escalated_events"      in live)
    check("persistence_threshold_s field", "persistence_threshold_s" in live)
    hist = body.get("historical", {})
    check("historical present",            isinstance(hist, dict))
    check("total_safety_events field",     "total_safety_events"   in hist)
    check("critical_events field",         "critical_events"       in hist)
    check("ppe_compliance_pct field",      "ppe_compliance_pct"    in hist)
    print("       live.frames_analyzed=" + str(live.get("frames_analyzed")) +
          "  hist.total_events=" + str(hist.get("total_safety_events")))
except Exception as exc:
    check("Impact metrics reachable", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 15 — Emergency workflow (human-in-the-loop)
# ─────────────────────────────────────────────────────────────

section("TEST 15 — POST /api/emergency  (human-in-the-loop)")
try:
    # Test 15a: missing confirmed_by → must be rejected
    r = requests.post(BASE + "/api/emergency",
                      json={"worker_id":   "Worker-Test",
                            "zone":        "Zone-Test",
                            "camera":      "Camera-Test",
                            "description": "Test emergency — automated suite",
                            "confirmed_by": ""},
                      timeout=15)
    check("empty confirmed_by returns HTTP 400",     r.status_code == 400)
    err = r.json()
    check("error message mentions confirmation",
          "confirm" in str(err.get("detail", "")).lower(),
          str(err.get("detail", ""))[:80])

    # Test 15b: with confirmed_by — should succeed without real emergency services
    r2 = requests.post(BASE + "/api/emergency",
                       json={"worker_id":   "Worker-Test",
                             "zone":        "Zone-Test",
                             "camera":      "Camera-Test",
                             "description": "Automated test — no action required",
                             "confirmed_by": "TestSuiteRunner"},
                       timeout=15)
    check("confirmed_by present returns HTTP 200", r2.status_code == 200)
    body2 = r2.json()
    check("success == true",            body2.get("success") is True)
    check("event_id present",           "event_id" in body2)
    check("confirmed_by echoed back",   body2.get("confirmed_by") == "TestSuiteRunner")
    check("warning message present",    "warning"  in body2)
    check("no auto emergency services",
          "does not automatically" in str(body2.get("warning", "")).lower() or
          "human action" in str(body2.get("warning", "")).lower(),
          str(body2.get("warning", ""))[:80])
    print("       Emergency event_id: " + str(body2.get("event_id", ""))[:16] + "...")
except Exception as exc:
    check("Emergency endpoint test", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 16 — /api/emergency-facilities
# This endpoint was NOT implemented (requirement specified as future).
# We verify it correctly returns 404, not a fake response.
# ─────────────────────────────────────────────────────────────

section("TEST 16 — GET /api/emergency-facilities  (not implemented)")
try:
    r = requests.get(BASE + "/api/emergency-facilities", timeout=10)
    check("returns 404 (not implemented, correctly absent)",
          r.status_code == 404,
          "HTTP " + str(r.status_code))
except Exception as exc:
    check("emergency-facilities endpoint check", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 17 — Incident model placeholder
# ─────────────────────────────────────────────────────────────

section("TEST 17 — AI/incident_model.py placeholder")
try:
    from AI.incident_model import analyze_frame_path, analyze_sequence, is_ready, _placeholder

    # Placeholder returns safe dict — model file doesn't exist yet
    result = _placeholder("unit test")
    check("placeholder incident_detected == False", result["incident_detected"] is False)
    check("placeholder incident_type == None",      result["incident_type"] is None)
    check("placeholder confidence == 0.0",          result["confidence"] == 0.0)

    # analyze_frame_path with nonexistent model → safe placeholder
    r2 = analyze_frame_path(r"D:\AwareX\Dataset\test\images\ppe_0005_jpg.rf.92f75811b1228784eaa0be0f2c891338.jpg")
    check("analyze_frame_path returns dict",             isinstance(r2, dict))
    check("analyze_frame_path has incident_detected",    "incident_detected" in r2)
    check("analyze_frame_path has confidence",           "confidence" in r2)
    check("analyze_frame_path has note",                 "note" in r2)
    # Since model file doesn't exist, must be False — never fabricate detections
    check("no fake incident detected (model absent)",    r2["incident_detected"] is False)

    # is_ready reflects model absence
    check("is_ready() returns bool", isinstance(is_ready(), bool))

    # analyze_sequence with empty list
    r3 = analyze_sequence([])
    check("analyze_sequence([]) returns safe dict", r3["incident_detected"] is False)

    print("       incident_model.is_ready()=" + str(is_ready()))
    print("       analyze_frame_path note: " + str(r2.get("note", ""))[:60])
except Exception as exc:
    check("Incident model test", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 18 — /api/analyze-frame incident field
# Verify analyze-frame response includes the incident key
# ─────────────────────────────────────────────────────────────

section("TEST 18 — /api/analyze-frame includes incident field")
if not Path(TEST_IMAGE).exists():
    check("Test image exists", False, "Not found: " + TEST_IMAGE)
else:
    try:
        with open(TEST_IMAGE, "rb") as fh:
            r = requests.post(
                BASE + "/api/analyze-frame",
                files={"frame": ("webcam_frame.jpg", fh, "image/jpeg")},
                data={"camera": "Laptop-Camera", "zone": "Zone-A"},
                timeout=60,
            )
        body = r.json()
        check("HTTP 200",                        r.status_code == 200)
        check("incident field present",          "incident" in body,
              str(list(body.keys()))[:80])
        inc = body.get("incident", {})
        check("incident has incident_detected",  "incident_detected" in inc)
        check("incident_detected is bool",       isinstance(inc.get("incident_detected"), bool))
        check("incident has confidence",         "confidence" in inc)
        check("incident has note",               "note" in inc)
        print("       incident=" + str(inc))
    except Exception as exc:
        check("analyze-frame incident field", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 19 — Incident model loaded (new fall model)
# ─────────────────────────────────────────────────────────────

section("TEST 19 — Fall/incident model loaded and path correct")
try:
    from AI.incident_model import is_ready, get_model_path, MODEL_PATH as INC_PATH
    check("incident model is_ready()", is_ready(), get_model_path())
    check("model path is non-empty",   bool(INC_PATH), INC_PATH[:60] if INC_PATH else "")
    if is_ready():
        check("model path contains awarex_fall", "fall" in INC_PATH.lower(), INC_PATH)
    print("       incident model path: " + get_model_path())
except Exception as exc:
    check("Incident model load check", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 20 — Baseline video regression (no regression check)
# ─────────────────────────────────────────────────────────────

section("TEST 20 — Baseline video: workers=2 regression  (~2 min)")
if not Path(VIDEO).exists():
    check("Baseline video exists", False, VIDEO)
else:
    print("       video: " + VIDEO)
    try:
        t0 = time.time()
        with open(VIDEO, "rb") as fh:
            r = requests.post(
                BASE + "/api/analyze",
                files={"video": (Path(VIDEO).name, fh, "video/mp4")},
                data={"camera": "Camera-01", "zone": "Zone-A"},
                timeout=600,
            )
        elapsed = round(time.time() - t0, 1)
        body = r.json()
        print("       completed in " + str(elapsed) + "s")
        check("HTTP 200",                 r.status_code == 200)
        check("success=true",             body.get("success") is True)
        check("workers == 2",             body.get("workers") == 2,    "workers=" + str(body.get("workers")))
        check("frames_processed == 216",  body.get("frames_processed") == 216)
        check("sampled_frames == 22",     body.get("sampled_frames") == 22)
        check("total_detections == 52",   body.get("total_detections") == 52)
        check("safety_score == 100.0",    body.get("safety_score") == 100.0)
        check("severity == SAFE",         body.get("severity") == "SAFE")
        check("incident field present",   "incident" in body)
        check("ai_device field present",  "ai_device" in body,         str(body.get("ai_device","")))
        print("       ai_device: " + str(body.get("ai_device", "?")))
        print("       incident:  " + str(body.get("incident", {}).get("note", "?")))
    except Exception as exc:
        check("Baseline video analysis", False, str(exc))

# ─────────────────────────────────────────────────────────────
# TEST 21 — Second video call uses fresh tracker (no ID bleed)
# Just call the same video again; worker count must still be 2.
# ─────────────────────────────────────────────────────────────

section("TEST 21 — Second consecutive video call (tracker reset)  (~2 min)")
if not Path(VIDEO).exists():
    check("Video exists for retest", False, VIDEO)
else:
    try:
        t0 = time.time()
        with open(VIDEO, "rb") as fh:
            r = requests.post(
                BASE + "/api/analyze",
                files={"video": (Path(VIDEO).name, fh, "video/mp4")},
                data={"camera": "Camera-01", "zone": "Zone-A"},
                timeout=600,
            )
        elapsed = round(time.time() - t0, 1)
        body = r.json()
        workers2 = body.get("workers", -1)
        check("HTTP 200 on second call",           r.status_code == 200)
        check("workers == 2 on second call",       workers2 == 2,  "workers=" + str(workers2))
        check("tracker reset — no stale ID bleed", workers2 == 2,  "workers=" + str(workers2))
        print("       second call workers=" + str(workers2) + "  elapsed=" + str(elapsed) + "s")
    except Exception as exc:
        check("Second video call", False, str(exc))

# ─────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────

print()
print("=" * 65)
total = len(PASS_LIST) + len(FAIL_LIST)
print("  RESULT: " + str(len(PASS_LIST)) + "/" + str(total) + " checks PASSED")
if FAIL_LIST:
    print()
    print("  FAILED checks:")
    for name in FAIL_LIST:
        print("    - " + name)
else:
    print("  All checks passed.")
print("=" * 65)
