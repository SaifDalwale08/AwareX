import io
import os
import json
import shutil
import tempfile
from datetime import datetime

import cv2

from dotenv import load_dotenv
from supabase import create_client, Client

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# ==========================================
# Environment
# ==========================================

load_dotenv()

SUPABASE_URL       = os.getenv("SUPABASE_URL")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY")
VIDEO_FRAME_INTERVAL = int(os.getenv("VIDEO_FRAME_INTERVAL", "10"))

if not SUPABASE_URL or not SUPABASE_SECRET_KEY:
    raise RuntimeError("Supabase credentials not found in .env")

# ==========================================
# Supabase
# ==========================================

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)

# ==========================================
# AwareX AI
# ==========================================

from AI.inference import analyze_image
from AI.safety_engine import analyze_safety
from AI.worker_tracking import WorkerTracker
from AI.notification_service import send_critical_alert, build_alert_message
from AI.live_monitor import LiveMonitor

# ── Singletons loaded once at startup ──
worker_tracker = WorkerTracker()          # used by /api/analyze (video)


def _escalation_callback(event):
    """Called by LiveMonitor when an event is not acked in time → send TextBee SMS."""
    try:
        send_critical_alert(
            violation      = event.violation,
            worker_id      = event.worker_id,
            zone           = event.zone,
            camera         = event.camera,
            severity       = "CRITICAL",
            confidence     = event.confidence,
            recommendation = "Manager did not acknowledge. Escalated automatically.",
        )
    except Exception as exc:
        import logging
        logging.getLogger("awarex.main").error("Escalation SMS failed: %s", exc)


live_monitor = LiveMonitor(escalation_callback=_escalation_callback)

# ==========================================
# FastAPI
# ==========================================

app = FastAPI(title="AwareX Backend", version="3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# Request models
# ==========================================

class AnalyzeRequest(BaseModel):
    image_path: str
    camera: str = "Camera-01"
    zone:   str = "Zone-A"

class ChatRequest(BaseModel):
    message: str

class NotifyRequest(BaseModel):
    violation:      str
    worker_id:      str   = "Worker-01"
    zone:           str   = "Zone-A"
    camera:         str   = "Camera-01"
    severity:       str   = "CRITICAL"
    confidence:     float = 0.9
    recommendation: str   = ""

class EmergencyRequest(BaseModel):
    worker_id:   str   = "Worker-01"
    zone:        str   = "Zone-A"
    camera:      str   = "Camera-01"
    description: str   = "Potential emergency detected"
    confirmed_by: str  = ""   # must be filled by a human operator

# ==========================================
# Root
# ==========================================

@app.get("/")
def root():
    return {"system": "AwareX", "status": "online", "version": "3.0"}

# ==========================================
# AI IMAGE ANALYSIS  (unchanged)
# ==========================================

@app.post("/api/analyze-image")
def analyze_image_endpoint(request: AnalyzeRequest):
    detections   = analyze_image(request.image_path)
    safety_result = analyze_safety(detections)
    stored_events = []
    for violation in safety_result["violations"]:
        event = {
            "camera":         request.camera,
            "zone":           request.zone,
            "violation":      violation["type"],
            "confidence":     violation["confidence"],
            "severity":       safety_result["severity"],
            "recommendation": safety_result["recommendation"],
            "status":         "OPEN",
        }
        response = supabase.table("safety_events").insert(event).execute()
        stored_events.extend(response.data or [])
    return {
        "success":       True,
        "camera":        request.camera,
        "zone":          request.zone,
        "detections":    detections,
        "safety":        safety_result,
        "stored_events": stored_events,
    }

# ==========================================
# VIDEO ANALYSIS  (unchanged — baseline verified)
# ==========================================

@app.post("/api/analyze")
def analyze_video(
    video:  UploadFile = File(...),
    camera: str        = Form("Camera-01"),
    zone:   str        = Form("Zone-A"),
):
    import time as _time
    import torch as _torch
    import logging as _logging

    _logger = _logging.getLogger("awarex.video")

    if not video.filename:
        raise HTTPException(status_code=400, detail="Video file is required.")

    file_ext = os.path.splitext(video.filename)[1].lower()
    if file_ext not in (".mp4", ".mov", ".avi", ".webm", ".mkv"):
        raise HTTPException(
            status_code=400,
            detail="Unsupported video format. Use MP4, MOV, AVI, WEBM, or MKV.",
        )

    # Determine AI device for logging
    _ai_device = ("CUDA/" + _torch.cuda.get_device_name(0)) if _torch.cuda.is_available() else "CPU"

    temp_dir = tempfile.mkdtemp(prefix="awarex_video_")
    # Strip path components to avoid directory traversal
    safe_name   = os.path.basename(video.filename)
    upload_path = os.path.join(temp_dir, safe_name)

    try:
        with open(upload_path, "wb") as out_file:
            shutil.copyfileobj(video.file, out_file)

        capture = cv2.VideoCapture(upload_path)
        if not capture.isOpened():
            raise HTTPException(status_code=400, detail="Unable to open uploaded video.")

        fps         = float(capture.get(cv2.CAP_PROP_FPS) or 0)
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

        sampled_frames   = 0
        frames_processed = 0
        all_detections   = []
        worker_ids       = set()
        worker_ppe_map: dict = {}
        frame_index      = 0

        while True:
            ret, frame = capture.read()
            if not ret:
                break
            frames_processed += 1
            frame_index      += 1
            if frame_index != 1 and frame_index % VIDEO_FRAME_INTERVAL != 0:
                continue
            sampled_frames += 1

            try:
                workers = worker_tracker.track_frame(frame)
                for worker in workers:
                    track_id = worker.get("track_id")
                    if track_id is not None:
                        worker_ids.add(track_id)
                        if track_id not in worker_ppe_map:
                            worker_ppe_map[track_id] = {
                                "bbox":           worker.get("bbox"),
                                "confidence":     worker.get("confidence", 0.0),
                                "ppe_seen":       [],
                                "violations_seen":[],
                            }
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"Worker tracking failure: {exc}")

            frame_file = os.path.join(temp_dir, f"frame_{frame_index}.jpg")
            if not cv2.imwrite(frame_file, frame):
                raise HTTPException(status_code=500, detail="Failed to write temporary frame image.")

            try:
                frame_detections = analyze_image(frame_file)
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"YOLO failure: {exc}")
            finally:
                try:
                    os.remove(frame_file)
                except OSError:
                    pass

            all_detections.extend(frame_detections)

            if worker_ids and frame_detections:
                frame_workers = workers if workers else []
                for detection in frame_detections:
                    det_bbox = detection.get("bbox", [])
                    if len(det_bbox) == 4:
                        det_cx = (det_bbox[0] + det_bbox[2]) / 2
                        det_cy = (det_bbox[1] + det_bbox[3]) / 2
                        best_id, best_dist = None, float("inf")
                        for w in frame_workers:
                            w_bbox = w.get("bbox", [])
                            if len(w_bbox) == 4:
                                w_cx = (w_bbox[0] + w_bbox[2]) / 2
                                w_cy = (w_bbox[1] + w_bbox[3]) / 2
                                dist = ((det_cx - w_cx)**2 + (det_cy - w_cy)**2)**0.5
                                if dist < best_dist:
                                    best_dist, best_id = dist, w.get("track_id")
                        if best_id is not None and best_dist < 300:
                            entry = worker_ppe_map.setdefault(best_id, {
                                "bbox": None, "confidence": 0.0,
                                "ppe_seen": [], "violations_seen": [],
                            })
                            cls = detection["class"]
                            lst = "violations_seen" if cls.startswith("no-") else "ppe_seen"
                            if cls not in entry[lst]:
                                entry[lst].append(cls)

        capture.release()

        if frames_processed == 0:
            raise HTTPException(status_code=400, detail="Uploaded video contains no readable frames.")

        safety_result = analyze_safety(all_detections)

        aggregated = {}
        for violation in safety_result["violations"]:
            key = (violation["type"], camera, zone)
            if key not in aggregated or violation["confidence"] > aggregated[key]["confidence"]:
                aggregated[key] = violation

        deduped_violations = []
        for violation in aggregated.values():
            severity = "CRITICAL" if violation["type"] in ("no-helmet", "no-vest") else "WARNING"
            deduped_violations.append({
                "violation":      violation["type"],
                "camera":         camera,
                "zone":           zone,
                "confidence":     violation["confidence"],
                "severity":       severity,
                "recommendation": safety_result["recommendation"],
                "status":         "OPEN",
            })

        stored_events = []
        if deduped_violations:
            response = supabase.table("safety_events").insert(deduped_violations).execute()
            if getattr(response, "error", None):
                raise HTTPException(status_code=500, detail=f"Supabase insert failed: {response.error}")
            stored_events = response.data or []

        total_workers       = len(worker_ids)
        notification_results = []
        for v in deduped_violations:
            if v["severity"] == "CRITICAL":
                worker_label = "Worker-01"
                for wid, wdata in worker_ppe_map.items():
                    if v["violation"] in wdata.get("violations_seen", []):
                        worker_label = f"Worker-{str(wid).zfill(2)}"
                        break
                notif = send_critical_alert(
                    violation      = v["violation"],
                    worker_id      = worker_label,
                    zone           = v["zone"],
                    camera         = v["camera"],
                    severity       = v["severity"],
                    confidence     = v["confidence"],
                    recommendation = v.get("recommendation", ""),
                )
                notification_results.append(notif)

        workers_summary = []
        for wid in sorted(worker_ids):
            wdata          = worker_ppe_map.get(wid, {})
            ppe_seen       = wdata.get("ppe_seen", [])
            violations_seen = wdata.get("violations_seen", [])
            has_critical   = any(v in violations_seen for v in ("no-helmet", "no-vest"))
            risk           = "Critical" if has_critical else ("High" if violations_seen else "Low")
            workers_summary.append({
                "id":         f"Worker-{str(wid).zfill(2)}",
                "track_id":   wid,
                "ppe": {
                    "helmet":  "no-helmet"  not in violations_seen and ("helmet"  in ppe_seen or not violations_seen),
                    "vest":    "no-vest"    not in violations_seen and ("vest"    in ppe_seen or not violations_seen),
                    "gloves":  "no-gloves"  not in violations_seen and ("gloves"  in ppe_seen or not violations_seen),
                    "boots":   "no-boots"   not in violations_seen and ("boots"   in ppe_seen or not violations_seen),
                    "goggles": "no-goggles" not in violations_seen and ("goggles" in ppe_seen or not violations_seen),
                },
                "violations": violations_seen,
                "risk":        risk,
                "confidence":  round(wdata.get("confidence", 0.0) * 100),
                "zone":        zone,
                "active":      True,
            })

        return {
            "success":            True,
            "workers":            total_workers,
            "workers_detail":     workers_summary,
            "video": {
                "name":           video.filename,
                "size":           os.path.getsize(upload_path),
                "duration":       round(frame_count / fps, 2) if fps else None,
                "frames":         frame_count,
                "sampled_frames": sampled_frames,
                "fps":            fps,
            },
            "frames_processed":   frames_processed,
            "sampled_frames":     sampled_frames,
            "total_detections":   safety_result["total_detections"],
            "violations":         deduped_violations,
            "critical_violations": safety_result["critical_violations"],
            "safety_score":       safety_result["safety_score"],
            "severity":           safety_result["severity"],
            "recommendations":    [safety_result["recommendation"]],
            "stored_events":      stored_events,
            "notifications":      notification_results,
        }

    finally:
        try:
            shutil.rmtree(temp_dir)
        except OSError:
            pass

# ==========================================
# LIVE FRAME ANALYSIS  (now uses LiveMonitor)
# ==========================================

@app.post("/api/analyze-frame")
async def analyze_frame(
    frame:  UploadFile = File(...),
    camera: str        = Form("Laptop-Camera"),
    zone:   str        = Form("Zone-A"),
):
    """
    Analyze a single frame from a live webcam.
    Uses the persistent LiveMonitor (WorkerTracker + PPE + persistence filter).
    """
    if not frame.filename:
        raise HTTPException(status_code=400, detail="Frame is required.")

    temp_dir   = tempfile.mkdtemp(prefix="awarex_frame_")
    frame_path = os.path.join(temp_dir, "webcam_frame.jpg")

    try:
        contents = await frame.read()
        if not contents:
            raise HTTPException(status_code=400, detail="Empty frame received.")

        with open(frame_path, "wb") as f:
            f.write(contents)

        result = live_monitor.process_frame(frame_path, camera=camera, zone=zone)

        # Store any NEW persistent critical events in Supabase
        for evt in result.get("new_critical_events", []):
            try:
                supabase.table("safety_events").insert({
                    "camera":         evt["camera"],
                    "zone":           evt["zone"],
                    "violation":      evt["violation"],
                    "confidence":     evt["confidence"],
                    "severity":       "CRITICAL",
                    "recommendation": "Immediate safety intervention required. Critical PPE violations detected.",
                    "status":         "OPEN",
                }).execute()
            except Exception:
                pass  # non-fatal

        return result

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Frame analysis failed: {exc}")
    finally:
        try:
            shutil.rmtree(temp_dir)
        except OSError:
            pass

# ==========================================
# DASHBOARD DATA  (unchanged)
# ==========================================

@app.get("/api/dashboard-data")
def get_dashboard_data():
    response = (
        supabase.table("safety_events")
        .select("*")
        .order("created_at", desc=True)
        .execute()
    )
    if getattr(response, "error", None):
        return {"success": False, "message": str(response.error),
                "total_events": 0, "critical_events": 0, "events": []}
    events         = response.data or []
    critical_count = sum(1 for e in events if str(e.get("severity", "")).upper() == "CRITICAL")
    return {
        "success":        True,
        "total_events":   len(events),
        "critical_events": critical_count,
        "events":         events,
    }

# ==========================================
# CHATBOT  (unchanged)
# ==========================================

@app.post("/api/chat")
def chat(request: ChatRequest):
    msg = request.message.strip().lower()
    try:
        resp   = supabase.table("safety_events").select("*").order("created_at", desc=True).execute()
        events = resp.data or []
    except Exception:
        events = []

    critical_events = [e for e in events if str(e.get("severity", "")).upper() == "CRITICAL"]
    warning_events  = [e for e in events if str(e.get("severity", "")).upper() == "WARNING"]
    total           = len(events)

    violation_counts: dict = {}
    for e in events:
        v = e.get("violation", "unknown")
        violation_counts[v] = violation_counts.get(v, 0) + 1
    most_common  = max(violation_counts, key=lambda k: violation_counts[k]) if violation_counts else None

    zone_counts: dict = {}
    for e in events:
        z = e.get("zone", "unknown")
        zone_counts[z] = zone_counts.get(z, 0) + 1
    hottest_zone = max(zone_counts, key=lambda k: zone_counts[k]) if zone_counts else None
    latest       = events[0] if events else None

    openai_key = os.getenv("OPENAI_API_KEY", "")
    if openai_key and total > 0:
        try:
            import urllib.request as _req
            summary_context = (
                f"AwareX Safety Database Summary:\n"
                f"Total events: {total}\nCritical: {len(critical_events)}\n"
                f"Warnings: {len(warning_events)}\n"
                f"Most common violation: {most_common} ({violation_counts.get(most_common, 0)} times)\n"
                f"Hottest zone: {hottest_zone}\n"
                f"Latest event: {json.dumps(latest)}\n"
                f"Recent 5 events: {json.dumps(events[:5])}\n"
            )
            payload = json.dumps({
                "model": "gpt-3.5-turbo",
                "messages": [
                    {"role": "system", "content": (
                        "You are AwareX Safety Intelligence, an AI assistant for an industrial "
                        "workplace safety platform. Answer using ONLY the real safety data provided. "
                        "Be concise and actionable.\n\n" + summary_context)},
                    {"role": "user", "content": request.message},
                ],
                "max_tokens": 300,
                "temperature": 0.3,
            }).encode("utf-8")
            req = _req.Request(
                "https://api.openai.com/v1/chat/completions",
                data=payload,
                headers={"Content-Type": "application/json",
                         "Authorization": f"Bearer {openai_key}"},
                method="POST",
            )
            with _req.urlopen(req, timeout=15) as r:
                result = json.loads(r.read().decode("utf-8"))
                answer = result["choices"][0]["message"]["content"].strip()
                return {"success": True, "answer": answer, "source": "openai",
                        "data_summary": {"total_events": total, "critical": len(critical_events)}}
        except Exception:
            pass

    answer = _deterministic_chat(
        msg=msg, events=events, critical_events=critical_events,
        warning_events=warning_events, total=total, most_common=most_common,
        violation_counts=violation_counts, hottest_zone=hottest_zone,
        zone_counts=zone_counts, latest=latest,
    )
    return {"success": True, "answer": answer, "source": "deterministic",
            "data_summary": {"total_events": total, "critical": len(critical_events)}}


def _deterministic_chat(msg, events, critical_events, warning_events, total,
                         most_common, violation_counts, hottest_zone, zone_counts, latest) -> str:
    if total == 0:
        if any(k in msg for k in ("hello", "hi", "hey")):
            return "Hello! I'm AwareX Safety Intelligence. No safety events recorded yet."
        return "No safety events recorded yet. Upload a video and run an analysis first."

    if any(k in msg for k in ("hello", "hi", "hey", "help")):
        return (f"Hello! I'm AwareX Safety Intelligence. "
                f"The database has {total} safety event(s), {len(critical_events)} critical. "
                f"Ask me: 'What are today's critical violations?', 'Which zone has the most violations?', "
                f"'Give me a safety summary.'")

    if any(k in msg for k in ("critical", "critical violation", "critical alert")):
        if not critical_events:
            return "No critical violations are currently recorded."
        lines = [f"• {e.get('violation','?')} — {e.get('zone','?')} / {e.get('camera','?')} "
                 f"(conf {round(float(e.get('confidence',0))*100)}%)" for e in critical_events[:5]]
        return (f"There are {len(critical_events)} critical violation(s):\n" +
                "\n".join(lines) + "\n\nImmediate PPE compliance intervention is recommended.")

    if any(k in msg for k in ("worker", "how many worker", "workers detected", "people")):
        return (f"There are {total} total safety events in the database. "
                f"For exact worker counts, run a new video analysis.")

    if any(k in msg for k in ("zone", "area", "location", "where")):
        if not hottest_zone:
            return "No zone data available yet."
        lines = [f"• {z}: {c} violation(s)" for z, c in sorted(zone_counts.items(), key=lambda x: -x[1])[:5]]
        return (f"Zone with most violations: {hottest_zone} ({zone_counts[hottest_zone]} event(s)).\n" +
                "\n".join(lines))

    if any(k in msg for k in ("latest", "last", "recent", "newest")):
        if not latest:
            return "No events recorded yet."
        created = latest.get("created_at", "")
        try:
            dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
            time_str = dt.strftime("%Y-%m-%d %H:%M")
        except Exception:
            time_str = created
        return (f"Latest safety event:\n• Violation: {latest.get('violation','?')}\n"
                f"• Zone: {latest.get('zone','?')}\n• Camera: {latest.get('camera','?')}\n"
                f"• Severity: {latest.get('severity','?')}\n• Time: {time_str}\n"
                f"• Recommendation: {latest.get('recommendation','See safety officer.')}")

    if any(k in msg for k in ("summary", "overview", "status", "report")):
        lines = [f"• {v}: {c} time(s)" for v, c in sorted(violation_counts.items(), key=lambda x: -x[1])[:5]]
        return (f"🛡️ AwareX Safety Summary\nTotal events: {total}\nCritical: {len(critical_events)}\n"
                f"Warnings: {len(warning_events)}\nMost common violation: {most_common}\n"
                f"Hottest zone: {hottest_zone}\n\nTop violations:\n" + "\n".join(lines))

    if any(k in msg for k in ("should", "manager", "action", "recommend", "do about", "what to do")):
        if critical_events:
            c = critical_events[0]
            return (f"For the critical violation '{c.get('violation','?')}' in {c.get('zone','?')}:\n"
                    f"1. Immediately stop work in that zone.\n2. Issue correct PPE to the worker.\n"
                    f"3. Document the incident.\n4. Brief the worker on PPE compliance.\n"
                    f"5. Perform a zone safety re-check before resuming.\n\n"
                    f"Recommendation: {c.get('recommendation','Immediate safety intervention required.')}")
        return "No critical violations active. Continue monitoring and maintain PPE compliance."

    if any(k in msg for k in ("helmet", "vest", "gloves", "boots", "goggles", "ppe")):
        rel = {v: c for v, c in violation_counts.items()
               if any(k in v for k in ("helmet", "vest", "gloves", "boots", "goggles"))}
        if rel:
            lines = [f"• {v}: {c} time(s)" for v, c in sorted(rel.items(), key=lambda x: -x[1])]
            return "PPE violation breakdown:\n" + "\n".join(lines)
        return "No PPE violations recorded yet."

    return (f"I have access to {total} safety event(s) ({len(critical_events)} critical, "
            f"{len(warning_events)} warnings). "
            f"Try: 'Give me a safety summary', 'What are the critical violations?', "
            f"'Which zone has the most violations?', 'What was the latest safety violation?'")

# ==========================================
# MANUAL NOTIFICATION TRIGGER  (unchanged)
# ==========================================

@app.post("/api/notify")
def trigger_notification(request: NotifyRequest):
    result = send_critical_alert(
        violation      = request.violation,
        worker_id      = request.worker_id,
        zone           = request.zone,
        camera         = request.camera,
        severity       = request.severity,
        confidence     = request.confidence,
        recommendation = request.recommendation,
    )
    return {"success": True, "notification": result}

# ==========================================
# ACKNOWLEDGE EVENT
# ==========================================

@app.post("/api/events/{event_id}/acknowledge")
def acknowledge_event(event_id: str):
    """
    Manager acknowledges a persistent critical event within the 30-second window.
    If acknowledged in time, escalation (TextBee SMS) is cancelled.
    """
    result = live_monitor.acknowledge_event(event_id)
    if not result.get("success"):
        raise HTTPException(status_code=404, detail=result.get("error", "Event not found"))
    return result

@app.get("/api/events")
def list_events():
    """List all critical events tracked by the live monitor this session."""
    return {"success": True, "events": live_monitor.get_all_events()}

# ==========================================
# IMPACT METRICS
# ==========================================

@app.get("/api/impact-metrics")
def impact_metrics():
    """
    Returns real measurable AwareX impact metrics.
    Live-session metrics come from LiveMonitor.
    Historical totals come from Supabase.
    """
    # Live-session data
    live = live_monitor.impact_metrics()

    # Historical Supabase data
    try:
        resp   = supabase.table("safety_events").select("*").execute()
        events = resp.data or []
    except Exception:
        events = []

    critical_hist = sum(1 for e in events if str(e.get("severity", "")).upper() == "CRITICAL")
    warning_hist  = sum(1 for e in events if str(e.get("severity", "")).upper() == "WARNING")
    acked_hist    = sum(1 for e in events if str(e.get("status", "")).upper() == "ACKNOWLEDGED")

    # PPE compliance from Supabase events (rough proxy: non-violation events)
    viol_classes = {"no-helmet", "no-vest", "no-gloves", "no-boots", "no-goggles"}
    total_hist = len(events)
    viol_hist  = sum(1 for e in events if e.get("violation", "") in viol_classes)
    hist_compliance = round((1 - viol_hist / total_hist) * 100) if total_hist else 100

    return {
        "success":                 True,
        "source":                  "live_session + supabase",
        # ── Live session ──
        "live_session": {
            "workers_monitored":      live["workers_monitored"],
            "frames_analyzed":        live["frames_analyzed"],
            "uptime_hours":           live["uptime_hours"],
            "open_events":            live["open_events"],
            "acknowledged_events":    live["acknowledged_events"],
            "escalated_events":       live["escalated_events"],
            "ppe_compliance_pct":     live["ppe_compliance_pct"],
            "avg_ack_time_seconds":   live["avg_ack_time_seconds"],
            "persistence_threshold_s": live["persistence_threshold_s"],
            "ack_timeout_s":          live["ack_timeout_s"],
        },
        # ── Historical (Supabase) ──
        "historical": {
            "total_safety_events":    total_hist,
            "critical_events":        critical_hist,
            "warning_events":         warning_hist,
            "acknowledged_events":    acked_hist,
            "ppe_compliance_pct":     hist_compliance,
        },
    }

# ==========================================
# EMERGENCY WORKFLOW
# ==========================================

@app.post("/api/emergency")
def report_emergency(request: EmergencyRequest):
    """
    Human-in-the-loop emergency workflow.

    The system NEVER automatically dispatches emergency services.
    A human operator (confirmed_by field) must explicitly trigger this endpoint.

    Workflow:
      AI detection → safety event → manager reviews → calls this endpoint
      → backend logs the emergency + notifies via SMS
      → manager then contacts emergency services if needed
    """
    if not request.confirmed_by.strip():
        raise HTTPException(
            status_code=400,
            detail=(
                "Emergency confirmation requires 'confirmed_by' field. "
                "A human operator must explicitly confirm before this action proceeds."
            ),
        )

    event_id  = __import__("uuid").uuid4().hex
    timestamp = datetime.now().isoformat()

    emergency_record = {
        "event_id":    event_id,
        "worker_id":   request.worker_id,
        "zone":        request.zone,
        "camera":      request.camera,
        "description": request.description,
        "confirmed_by": request.confirmed_by,
        "timestamp":   timestamp,
        "status":      "CONFIRMED_BY_HUMAN",
    }

    # Log to alerts.log
    import logging as _log
    _log.getLogger("awarex.emergency").warning(
        "EMERGENCY CONFIRMED: %s", json.dumps(emergency_record)
    )

    # Send SMS notification via TextBee
    msg = (
        f"🚨 AwareX Emergency Alert\n"
        f"Worker: {request.worker_id}\n"
        f"Zone: {request.zone} | Camera: {request.camera}\n"
        f"Description: {request.description}\n"
        f"Confirmed by: {request.confirmed_by}\n"
        f"Time: {datetime.now().strftime('%I:%M %p')}\n"
        f"ACTION REQUIRED: Contact emergency services if needed."
    )
    notif = send_critical_alert(
        violation      = "EMERGENCY",
        worker_id      = request.worker_id,
        zone           = request.zone,
        camera         = request.camera,
        severity       = "CRITICAL",
        confidence     = 1.0,
        recommendation = request.description,
    )

    # Attempt Supabase store (best-effort)
    try:
        supabase.table("safety_events").insert({
            "camera":         request.camera,
            "zone":           request.zone,
            "violation":      "EMERGENCY",
            "confidence":     1.0,
            "severity":       "CRITICAL",
            "recommendation": f"Emergency confirmed by {request.confirmed_by}: {request.description}",
            "status":         "OPEN",
        }).execute()
    except Exception:
        pass

    return {
        "success":          True,
        "event_id":         event_id,
        "message":          "Emergency logged and manager notified via SMS. Contact emergency services if required.",
        "confirmed_by":     request.confirmed_by,
        "notification":     notif,
        "emergency_record": emergency_record,
        "warning":          (
            "AwareX does NOT automatically dispatch emergency services. "
            "Human action is required."
        ),
    }

# ==========================================
# REPORT GENERATION  (unchanged)
# ==========================================

@app.get("/api/report")
def generate_report(
    format: str = "html",
    camera: str = "All Cameras",
    zone:   str = "All Zones",
):
    try:
        resp   = supabase.table("safety_events").select("*").order("created_at", desc=True).execute()
        events = resp.data or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not fetch safety events: {e}")

    critical_events  = [e for e in events if str(e.get("severity", "")).upper() == "CRITICAL"]
    warning_events   = [e for e in events if str(e.get("severity", "")).upper() == "WARNING"]
    violation_counts: dict = {}
    for e in events:
        v = e.get("violation", "unknown")
        violation_counts[v] = violation_counts.get(v, 0) + 1

    total          = len(events)
    safety_score   = max(0, round(100 - total * 10)) if total > 0 else 100
    severity_label = "CRITICAL" if critical_events else ("WARNING" if warning_events else "SAFE")
    now_str        = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    report_id      = f"RPT-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    recommendations = []
    if critical_events:
        recommendations.append("Immediate safety intervention required for critical violations.")
    if warning_events:
        recommendations.append("Safety officer attention recommended for PPE compliance issues.")
    if not events:
        recommendations.append("No violations detected. Continue routine monitoring.")

    if format.lower() == "pdf":
        return _generate_pdf_report(
            events=events, critical_events=critical_events, warning_events=warning_events,
            violation_counts=violation_counts, total=total, safety_score=safety_score,
            severity_label=severity_label, now_str=now_str, report_id=report_id,
            recommendations=recommendations, camera=camera, zone=zone,
        )

    html = _build_html_report(
        events=events, critical_events=critical_events, warning_events=warning_events,
        violation_counts=violation_counts, total=total, safety_score=safety_score,
        severity_label=severity_label, now_str=now_str, report_id=report_id,
        recommendations=recommendations, camera=camera, zone=zone,
    )
    return StreamingResponse(
        io.BytesIO(html.encode("utf-8")), media_type="text/html",
        headers={"Content-Disposition": f'attachment; filename="{report_id}-awarex-report.html"'},
    )


def _build_html_report(events, critical_events, warning_events, violation_counts,
                        total, safety_score, severity_label, now_str, report_id,
                        recommendations, camera, zone) -> str:
    sev_color = {"CRITICAL": "#DC2626", "WARNING": "#D97706", "SAFE": "#16A34A"}.get(severity_label, "#6B7280")
    violation_rows = ""
    for e in events[:50]:
        created = e.get("created_at", "")
        try:
            dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
            time_str = dt.strftime("%Y-%m-%d %H:%M")
        except Exception:
            time_str = created
        sev   = e.get("severity", "")
        sev_c = "#DC2626" if str(sev).upper() == "CRITICAL" else "#D97706"
        conf  = round(float(e.get("confidence", 0)) * 100)
        violation_rows += (
            f"<tr><td>{e.get('violation','?')}</td><td>{e.get('camera','?')}</td>"
            f"<td>{e.get('zone','?')}</td><td style='color:{sev_c};font-weight:700'>{sev}</td>"
            f"<td>{conf}%</td><td>{time_str}</td><td>{e.get('recommendation','')[:80]}</td></tr>"
        )
    vio_freq_rows = "".join(
        f"<tr><td>{v}</td><td>{c}</td></tr>"
        for v, c in sorted(violation_counts.items(), key=lambda x: -x[1])
    )
    rec_items = "".join(f"<li>{r}</li>" for r in recommendations)
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>AwareX Safety Report {report_id}</title>
<style>
  body{{font-family:Inter,Arial,sans-serif;margin:0;padding:32px;background:#F7F9FB;color:#1a202c;}}
  h1{{font-size:26px;font-weight:900;color:#004AC6;margin:0;}}
  h2{{font-size:16px;font-weight:800;margin:24px 0 8px;border-bottom:2px solid #E2E8F0;padding-bottom:4px;}}
  .header{{display:flex;align-items:center;gap:18px;margin-bottom:28px;border-bottom:3px solid #004AC6;padding-bottom:18px;}}
  .meta{{font-size:12px;color:#6B7280;}}
  .kpi-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:24px;}}
  .kpi{{background:#fff;border-radius:10px;padding:18px;box-shadow:0 1px 4px rgba(0,0,0,.08);}}
  .kpi small{{font-size:12px;color:#6B7280;display:block;margin-bottom:4px;}}
  .kpi strong{{font-size:28px;font-weight:900;color:#004AC6;}}
  table{{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);}}
  th{{background:#004AC6;color:#fff;padding:10px 12px;text-align:left;font-size:12px;}}
  td{{padding:9px 12px;font-size:12px;border-bottom:1px solid #E2E8F0;}}
  tr:last-child td{{border-bottom:none;}}
  ul{{padding-left:20px;}} li{{margin-bottom:6px;font-size:13px;}}
  .footer{{margin-top:32px;font-size:11px;color:#9CA3AF;border-top:1px solid #E2E8F0;padding-top:12px;}}
</style></head><body>
<div class="header">
  <div><h1>AwareX</h1><div style="font-size:13px;color:#6B7280;">AI Safety Intelligence Platform</div></div>
  <div style="flex:1"></div>
  <div style="text-align:right;">
    <div style="font-size:18px;font-weight:800;">Safety Analysis Report</div>
    <div class="meta">Report ID: {report_id} &nbsp;|&nbsp; Generated: {now_str}</div>
    <div class="meta">Camera: {camera} &nbsp;|&nbsp; Zone: {zone}</div>
  </div>
</div>
<h2>Executive Summary</h2>
<div class="kpi-grid">
  <div class="kpi"><small>Safety Score</small><strong>{safety_score}%</strong></div>
  <div class="kpi"><small>Total Violations</small><strong>{total}</strong></div>
  <div class="kpi"><small>Critical Violations</small><strong style="color:#DC2626">{len(critical_events)}</strong></div>
  <div class="kpi"><small>Warnings</small><strong style="color:#D97706">{len(warning_events)}</strong></div>
  <div class="kpi"><small>Overall Severity</small><strong style="color:{sev_color}">{severity_label}</strong></div>
</div>
<h2>Recommendations</h2><ul>{rec_items}</ul>
<h2>Violation Frequency</h2>
<table><thead><tr><th>Violation Type</th><th>Count</th></tr></thead><tbody>{vio_freq_rows}</tbody></table>
<h2>Detailed Violation Log (latest 50)</h2>
<table><thead><tr><th>Violation</th><th>Camera</th><th>Zone</th><th>Severity</th><th>Confidence</th><th>Time</th><th>Recommendation</th></tr></thead>
<tbody>{violation_rows or '<tr><td colspan="7" style="text-align:center;color:#6B7280;">No violations recorded.</td></tr>'}</tbody></table>
<div class="footer">Generated by AwareX Safety Intelligence &nbsp;|&nbsp; {now_str} &nbsp;|&nbsp; Real data from Supabase</div>
</body></html>"""


def _generate_pdf_report(events, critical_events, warning_events, violation_counts,
                          total, safety_score, severity_label, now_str, report_id,
                          recommendations, camera, zone):
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
    except ImportError:
        raise HTTPException(
            status_code=501,
            detail="reportlab not installed. Use format=html or: pip install reportlab==4.2.5",
        )
    buf  = io.BytesIO()
    doc  = SimpleDocTemplate(buf, pagesize=A4,
                              leftMargin=20*mm, rightMargin=20*mm,
                              topMargin=20*mm, bottomMargin=20*mm)
    styles = getSampleStyleSheet()
    primary = colors.HexColor("#004AC6")
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], textColor=primary, fontSize=22, spaceAfter=4)
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], textColor=primary, fontSize=13, spaceBefore=16, spaceAfter=4)
    body  = ParagraphStyle("body",  parent=styles["Normal"], fontSize=10, spaceAfter=4)
    small = ParagraphStyle("small", parent=styles["Normal"], fontSize=8,
                            textColor=colors.HexColor("#6B7280"))
    sev_color_rl = (colors.HexColor("#DC2626") if severity_label == "CRITICAL"
                    else colors.HexColor("#D97706") if severity_label == "WARNING"
                    else colors.HexColor("#16A34A"))
    story = [
        Paragraph("AwareX — Safety Analysis Report", h1),
        Paragraph(f"Report ID: {report_id}  |  Generated: {now_str}  |  Camera: {camera}  |  Zone: {zone}", small),
        Spacer(1, 10*mm),
    ]
    story.append(Paragraph("Executive Summary", h2))
    t = Table(
        [["Safety Score", "Total Violations", "Critical", "Warnings", "Severity"],
         [f"{safety_score}%", str(total), str(len(critical_events)), str(len(warning_events)), severity_label]],
        colWidths=[35*mm, 38*mm, 30*mm, 30*mm, 30*mm],
    )
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), primary), ("TEXTCOLOR", (0,0), (-1,0), colors.white),
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"), ("FONTSIZE", (0,0), (-1,1), 10),
        ("ALIGN", (0,0), (-1,-1), "CENTER"),
        ("GRID", (0,0), (-1,-1), 0.5, colors.HexColor("#E2E8F0")),
        ("BACKGROUND", (0,1), (-1,1), colors.HexColor("#F7F9FB")),
        ("TEXTCOLOR", (4,1), (4,1), sev_color_rl), ("FONTNAME", (4,1), (4,1), "Helvetica-Bold"),
    ]))
    story.extend([t, Spacer(1, 6*mm)])
    story.append(Paragraph("Recommendations", h2))
    for r in recommendations:
        story.append(Paragraph(f"• {r}", body))
    story.append(Spacer(1, 8*mm))
    story.append(Paragraph(f"Generated by AwareX Safety Intelligence  |  {now_str}", small))
    doc.build(story)
    buf.seek(0)
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{report_id}-awarex-report.pdf"'},
    )
