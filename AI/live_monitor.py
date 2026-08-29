"""
AwareX Live Monitor
====================
Maintains persistent state across consecutive webcam frames.

Responsibilities:
  - Single shared WorkerTracker instance (no re-instantiation per frame)
  - PPE-worker spatial association per frame
  - Temporal / persistence filter: a violation becomes PERSISTENT only
    after it appears consistently for VIOLATION_PERSISTENCE_SECONDS
  - Critical event management with deduplication
  - Acknowledgement workflow + escalation timer

NOT responsible for:
  - HTTP routing (that lives in main.py)
  - SMS dispatch (that lives in notification_service.py)
  - Supabase writes (done in main.py after LiveMonitor returns results)
"""

from __future__ import annotations

import os
import time
import uuid
import threading
import logging
from collections import defaultdict
from datetime import datetime
from typing import Callable, Dict, List, Optional

from AI.worker_tracking import WorkerTracker
from AI.inference import analyze_image
from AI.safety_engine import analyze_safety, CRITICAL_VIOLATIONS

# ─────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────

PERSISTENCE_SECONDS   = float(os.getenv("VIOLATION_PERSISTENCE_SECONDS", "5"))
ACK_TIMEOUT_SECONDS   = float(os.getenv("ALERT_ACK_TIMEOUT_SECONDS", "30"))
ASSOCIATION_MAX_PX    = 350   # max centre-to-centre distance for PPE ↔ worker link
FPS_ESTIMATE          = 10    # frames-per-second for the webcam feed (matches frame interval)

logger = logging.getLogger("awarex.live_monitor")

# PPE class names produced by best.pt
PPE_WORN_CLASSES      = {"helmet", "vest", "gloves", "boots", "goggles"}
PPE_VIOLATION_CLASSES = {"no-helmet", "no-vest", "no-gloves", "no-boots", "no-goggles"}

# Map violation → ppe key
VIOLATION_TO_PPE = {
    "no-helmet":  "helmet",
    "no-vest":    "vest",
    "no-gloves":  "gloves",
    "no-boots":   "boots",
    "no-goggles": "goggles",
}

# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def _bbox_centre(bbox: list) -> tuple:
    return ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)


def _centre_dist(a: list, b: list) -> float:
    ax, ay = _bbox_centre(a)
    bx, by = _bbox_centre(b)
    return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5


def _iou(a: list, b: list) -> float:
    """Intersection over union for two [x1,y1,x2,y2] boxes."""
    ix1 = max(a[0], b[0]); iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2]); iy2 = min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter == 0:
        return 0.0
    area_a = (a[2]-a[0]) * (a[3]-a[1])
    area_b = (b[2]-b[0]) * (b[3]-b[1])
    return inter / (area_a + area_b - inter)


def _bbox_contains(outer: list, inner: list, margin: float = 0.15) -> bool:
    """True if 'inner' centre lies within 'outer' expanded by margin."""
    w = outer[2] - outer[0]
    h = outer[3] - outer[1]
    cx, cy = _bbox_centre(inner)
    return (outer[0] - w*margin <= cx <= outer[2] + w*margin and
            outer[1] - h*margin <= cy <= outer[3] + h*margin)


# ─────────────────────────────────────────────────────────────
# Per-worker state
# ─────────────────────────────────────────────────────────────

class _WorkerState:
    """Mutable state for one tracked worker across frames."""

    def __init__(self, track_id: int, zone: str, camera: str):
        self.track_id   = track_id
        self.worker_id  = f"Worker-{str(track_id).zfill(2)}"
        self.zone       = zone
        self.camera     = camera
        self.last_seen  = time.time()
        self.bbox: Optional[list] = None
        self.confidence = 0.0

        # Per-violation: first timestamp when it was continuously seen
        self._viol_first_seen:  Dict[str, float] = {}
        # Per-violation: last timestamp it was seen
        self._viol_last_seen:   Dict[str, float] = {}
        # Persistent violations (confirmed for >= PERSISTENCE_SECONDS)
        self.persistent_violations: Dict[str, dict] = {}

        # PPE status: True=worn, False=missing, None=uncertain
        self.ppe_status: Dict[str, Optional[bool]] = {
            k: None for k in ("helmet", "vest", "gloves", "boots", "goggles")
        }
        # raw counts this frame
        self._frame_ppe_seen:  List[str] = []
        self._frame_viol_seen: List[str] = []

    # ── called every frame ───────────────────────────────────

    def begin_frame(self, bbox: list, confidence: float, zone: str, camera: str):
        self.bbox       = bbox
        self.confidence = confidence
        self.last_seen  = time.time()
        self.zone       = zone
        self.camera     = camera
        self._frame_ppe_seen  = []
        self._frame_viol_seen = []

    def record_ppe(self, cls: str):
        """Record a PPE detection associated with this worker this frame."""
        if cls in PPE_WORN_CLASSES:
            self._frame_ppe_seen.append(cls)
        elif cls in PPE_VIOLATION_CLASSES:
            self._frame_viol_seen.append(cls)

    def end_frame(self):
        """Resolve PPE status + update persistence timers after all detections added."""
        now = time.time()

        # For each PPE slot, determine current frame observation
        for viol_cls, ppe_key in VIOLATION_TO_PPE.items():
            worn_cls  = ppe_key  # e.g. "helmet"
            seen_worn = worn_cls  in self._frame_ppe_seen
            seen_viol = viol_cls in self._frame_viol_seen

            if seen_viol and not seen_worn:
                # Violation clearly detected this frame
                self.ppe_status[ppe_key] = False
                if viol_cls not in self._viol_first_seen:
                    self._viol_first_seen[viol_cls] = now
                self._viol_last_seen[viol_cls] = now

                # Check persistence threshold
                elapsed = now - self._viol_first_seen[viol_cls]
                if elapsed >= PERSISTENCE_SECONDS and viol_cls not in self.persistent_violations:
                    self.persistent_violations[viol_cls] = {
                        "violation":   viol_cls,
                        "first_seen":  datetime.fromtimestamp(
                            self._viol_first_seen[viol_cls]).isoformat(),
                        "confirmed_at": datetime.now().isoformat(),
                        "elapsed_s":   round(elapsed, 1),
                    }

            elif seen_worn and not seen_viol:
                # PPE clearly worn this frame — reset violation streak
                self.ppe_status[ppe_key] = True
                self._viol_first_seen.pop(viol_cls, None)
                self._viol_last_seen.pop(viol_cls, None)
                # If it was persistent, remove it (worker put PPE back on)
                self.persistent_violations.pop(viol_cls, None)

            else:
                # Neither detected — uncertain
                # Keep existing status; clear streak if not seen recently
                last = self._viol_last_seen.get(viol_cls)
                if last and (now - last) > PERSISTENCE_SECONDS * 2:
                    # Not seen for a while → reset
                    self._viol_first_seen.pop(viol_cls, None)
                    self._viol_last_seen.pop(viol_cls, None)
                    if self.ppe_status[ppe_key] is False:
                        self.ppe_status[ppe_key] = None  # back to uncertain

    def ppe_summary(self) -> dict:
        """Return PPE status dict for API response."""
        out = {}
        for key, status in self.ppe_status.items():
            if status is True:
                out[key] = True
            elif status is False:
                out[key] = False
            else:
                out[key] = "UNCERTAIN / MANUAL VERIFICATION REQUIRED"
        return out

    def risk_level(self) -> str:
        p = self.persistent_violations
        if any(v in p for v in CRITICAL_VIOLATIONS):
            return "Critical"
        if p:
            return "High"
        # Check non-persistent violations still in progress
        if any(v in self.ppe_status and self.ppe_status[VIOLATION_TO_PPE[v]] is False
               for v in VIOLATION_TO_PPE):
            return "Medium"
        return "Low"

    def safety_score(self) -> int:
        n_missing = sum(1 for v in self.ppe_status.values() if v is False)
        return max(0, 100 - n_missing * 15)

    def to_dict(self) -> dict:
        return {
            "id":           self.worker_id,
            "track_id":     self.track_id,
            "zone":         self.zone,
            "camera":       self.camera,
            "ppe":          self.ppe_summary(),
            "violations":   list(self.persistent_violations.keys()),
            "all_violations_seen": list(self._frame_viol_seen),
            "risk":         self.risk_level(),
            "safety_score": self.safety_score(),
            "active":       True,
            "confidence":   round(self.confidence * 100),
            "last_seen":    datetime.fromtimestamp(self.last_seen).strftime("%H:%M:%S"),
        }


# ─────────────────────────────────────────────────────────────
# Critical event
# ─────────────────────────────────────────────────────────────

class CriticalEvent:
    def __init__(
        self,
        worker_id: str,
        violation: str,
        confidence: float,
        zone: str,
        camera: str,
    ):
        self.event_id   = str(uuid.uuid4())
        self.worker_id  = worker_id
        self.violation  = violation
        self.confidence = confidence
        self.zone       = zone
        self.camera     = camera
        self.first_seen = datetime.now().isoformat()
        self.last_seen  = self.first_seen
        self.status     = "OPEN"          # OPEN | ACKNOWLEDGED | ESCALATED
        self.sms_sent   = False
        self._created_ts = time.time()

    def acknowledge(self) -> None:
        self.status   = "ACKNOWLEDGED"
        self.last_seen = datetime.now().isoformat()

    def escalate(self) -> None:
        self.status   = "ESCALATED"
        self.last_seen = datetime.now().isoformat()

    def touch(self) -> None:
        self.last_seen = datetime.now().isoformat()

    def age_seconds(self) -> float:
        return time.time() - self._created_ts

    def to_dict(self) -> dict:
        return {
            "event_id":   self.event_id,
            "worker_id":  self.worker_id,
            "violation":  self.violation,
            "confidence": self.confidence,
            "zone":       self.zone,
            "camera":     self.camera,
            "first_seen": self.first_seen,
            "last_seen":  self.last_seen,
            "status":     self.status,
            "sms_sent":   self.sms_sent,
        }


# ─────────────────────────────────────────────────────────────
# LiveMonitor
# ─────────────────────────────────────────────────────────────

class LiveMonitor:
    """
    Singleton-style class.  Instantiate ONCE at application startup.
    Call process_frame() for every incoming webcam frame.
    """

    def __init__(self, escalation_callback: Optional[Callable[[CriticalEvent], None]] = None):
        """
        escalation_callback: called when an event is not acknowledged within
                             ACK_TIMEOUT_SECONDS.  main.py injects the SMS sender.
        """
        self._tracker           = WorkerTracker()
        self._worker_states:    Dict[int, _WorkerState] = {}
        self._critical_events:  Dict[str, CriticalEvent] = {}   # event_id → event
        self._escalation_cb     = escalation_callback
        self._lock              = threading.Lock()
        self._frame_count       = 0
        self._session_start     = time.time()

    # ── public API ────────────────────────────────────────────

    def process_frame(
        self,
        frame_path: str,
        camera: str = "Laptop-Camera",
        zone:   str = "Zone-A",
    ) -> dict:
        """
        Run full analysis on one frame.
        Returns dict ready to be returned from /api/analyze-frame.
        """
        with self._lock:
            self._frame_count += 1

            # 1. Worker tracking (persistent model state via persist=True)
            import cv2
            img = cv2.imread(frame_path)
            if img is None:
                raise ValueError(f"Cannot read frame: {frame_path}")

            raw_workers = self._tracker.track_frame(img)

            # 2. Update worker state objects
            for rw in raw_workers:
                tid = rw.get("track_id")
                if tid is None:
                    continue
                if tid not in self._worker_states:
                    self._worker_states[tid] = _WorkerState(tid, zone, camera)
                ws = self._worker_states[tid]
                ws.begin_frame(
                    bbox=rw.get("bbox", []),
                    confidence=rw.get("confidence", 0.0),
                    zone=zone,
                    camera=camera,
                )

            # 3. PPE YOLO detection
            from AI.inference import analyze_image as _analyze_image
            detections = _analyze_image(frame_path)

            # 3.5. Incident model (fall / accident detection)
            # Non-blocking: if model not loaded, returns safe placeholder
            try:
                from AI.incident_model import analyze_frame_path as _analyze_incident
                incident_result = _analyze_incident(frame_path)
            except Exception:
                incident_result = {
                    "incident_detected": False,
                    "incident_type": None,
                    "confidence": 0.0,
                    "bbox": None,
                    "note": "Incident model unavailable",
                }

            # 4. PPE ↔ worker spatial association
            active_ids = {rw["track_id"] for rw in raw_workers if rw.get("track_id") is not None}
            active_workers_list = [rw for rw in raw_workers if rw.get("track_id") in active_ids]

            for det in detections:
                cls     = det.get("class", "")
                det_bbox = det.get("bbox", [])
                if len(det_bbox) != 4:
                    continue

                # Strategy:
                #   1) Prefer a worker whose bbox CONTAINS the PPE centre
                #   2) Fall back to nearest worker within ASSOCIATION_MAX_PX
                best_id   = None
                best_score = -1.0

                for rw in active_workers_list:
                    tid  = rw.get("track_id")
                    wbbox = rw.get("bbox", [])
                    if len(wbbox) != 4 or tid not in self._worker_states:
                        continue

                    if _bbox_contains(wbbox, det_bbox):
                        # Strong: PPE centre is inside the worker box
                        score = 1000.0  # prioritised
                    else:
                        dist = _centre_dist(wbbox, det_bbox)
                        if dist > ASSOCIATION_MAX_PX:
                            continue
                        score = ASSOCIATION_MAX_PX - dist  # higher = closer

                    if score > best_score:
                        best_score = score
                        best_id    = tid

                if best_id is not None:
                    self._worker_states[best_id].record_ppe(cls)

            # 5. End-of-frame PPE resolution + persistence update
            for tid in active_ids:
                if tid in self._worker_states:
                    self._worker_states[tid].end_frame()

            # 6. Build workers_detail list
            workers_detail = [
                self._worker_states[tid].to_dict()
                for tid in sorted(active_ids)
                if tid in self._worker_states
            ]

            # 7. Collect persistent violations from active workers
            new_critical_events = []
            for tid in active_ids:
                ws = self._worker_states.get(tid)
                if ws is None:
                    continue
                for viol_cls, viol_info in ws.persistent_violations.items():
                    severity = "CRITICAL" if viol_cls in CRITICAL_VIOLATIONS else "WARNING"
                    if severity != "CRITICAL":
                        continue
                    # Dedup: one open event per worker+violation
                    dedup_key = f"{ws.worker_id}::{viol_cls}"
                    existing = next(
                        (e for e in self._critical_events.values()
                         if e.worker_id == ws.worker_id
                         and e.violation == viol_cls
                         and e.status == "OPEN"),
                        None,
                    )
                    if existing:
                        existing.touch()
                    else:
                        evt = CriticalEvent(
                            worker_id  = ws.worker_id,
                            violation  = viol_cls,
                            confidence = ws.confidence,
                            zone       = ws.zone,
                            camera     = ws.camera,
                        )
                        self._critical_events[evt.event_id] = evt
                        new_critical_events.append(evt.to_dict())
                        # Start ack timer
                        self._start_ack_timer(evt)

            # 8. Safety intelligence using all detections
            from AI.safety_engine import analyze_safety as _analyze_safety
            safety_result = _analyze_safety(detections)

            # 9. Collect all open events
            open_events = [
                e.to_dict() for e in self._critical_events.values()
                if e.status == "OPEN"
            ]

            return {
                "success":            True,
                "camera":             camera,
                "zone":               zone,
                "frame_count":        self._frame_count,
                "workers":            len(active_ids),
                "workers_detail":     workers_detail,
                "detections":         detections,
                "total_detections":   len(detections),
                "safety":             safety_result,
                "safety_score":       safety_result["safety_score"],
                "severity":           safety_result["severity"],
                "recommendations":    [safety_result["recommendation"]],
                "violations":         safety_result["violations"],
                "new_critical_events": new_critical_events,
                "open_critical_events": open_events,
                "incident":           incident_result,
            }

    # ── acknowledgement ───────────────────────────────────────

    def acknowledge_event(self, event_id: str) -> dict:
        with self._lock:
            evt = self._critical_events.get(event_id)
            if evt is None:
                return {"success": False, "error": "Event not found", "event_id": event_id}
            if evt.status != "OPEN":
                return {
                    "success":  True,
                    "message":  f"Event already {evt.status}",
                    "event":    evt.to_dict(),
                }
            evt.acknowledge()
            logger.info("Event %s acknowledged by manager", event_id)
            return {
                "success": True,
                "message": "Event acknowledged. Escalation cancelled.",
                "event":   evt.to_dict(),
            }

    def get_event(self, event_id: str) -> Optional[CriticalEvent]:
        return self._critical_events.get(event_id)

    def get_all_events(self) -> List[dict]:
        with self._lock:
            return [e.to_dict() for e in self._critical_events.values()]

    # ── impact metrics ────────────────────────────────────────

    def impact_metrics(self) -> dict:
        with self._lock:
            all_e = list(self._critical_events.values())
            acked  = [e for e in all_e if e.status == "ACKNOWLEDGED"]
            esc    = [e for e in all_e if e.status == "ESCALATED"]
            open_e = [e for e in all_e if e.status == "OPEN"]

            # PPE compliance across all known workers
            all_ws = list(self._worker_states.values())
            total_slots = len(all_ws) * 5  # 5 PPE items each
            worn_slots  = sum(
                sum(1 for v in ws.ppe_status.values() if v is True)
                for ws in all_ws
            )
            ppe_pct = round(worn_slots / total_slots * 100) if total_slots else 100

            # Average ack time (seconds) — from event creation to ack
            ack_times = []
            for e in acked:
                try:
                    t0 = datetime.fromisoformat(e.first_seen)
                    t1 = datetime.fromisoformat(e.last_seen)
                    ack_times.append((t1 - t0).total_seconds())
                except Exception:
                    pass
            avg_ack = round(sum(ack_times) / len(ack_times), 1) if ack_times else None

            uptime_h = round((time.time() - self._session_start) / 3600, 2)

            return {
                "workers_monitored":         len(all_ws),
                "unique_worker_ids":         [ws.worker_id for ws in all_ws],
                "frames_analyzed":           self._frame_count,
                "uptime_hours":              uptime_h,
                "total_critical_events":     len(all_e),
                "open_events":               len(open_e),
                "acknowledged_events":       len(acked),
                "escalated_events":          len(esc),
                "ppe_compliance_pct":        ppe_pct,
                "avg_ack_time_seconds":      avg_ack,
                "persistence_threshold_s":   PERSISTENCE_SECONDS,
                "ack_timeout_s":             ACK_TIMEOUT_SECONDS,
            }

    # ── reset (for testing) ───────────────────────────────────

    def reset(self) -> None:
        with self._lock:
            self._worker_states.clear()
            self._critical_events.clear()
            self._frame_count   = 0
            self._session_start = time.time()

    # ── internal ──────────────────────────────────────────────

    def _start_ack_timer(self, evt: CriticalEvent) -> None:
        """Start a daemon thread that escalates the event if not acked in time."""
        if self._escalation_cb is None:
            return

        def _timer():
            time.sleep(ACK_TIMEOUT_SECONDS)
            with self._lock:
                current = self._critical_events.get(evt.event_id)
                if current and current.status == "OPEN":
                    current.escalate()
                    logger.warning(
                        "Event %s NOT acknowledged in %.0fs — escalating",
                        evt.event_id, ACK_TIMEOUT_SECONDS,
                    )
                    try:
                        self._escalation_cb(current)
                    except Exception as exc:
                        logger.error("Escalation callback failed: %s", exc)

        t = threading.Thread(target=_timer, daemon=True, name=f"ack-timer-{evt.event_id[:8]}")
        t.start()
