"""
AwareX Incident Model Interface
=================================
PLACEHOLDER — safe no-op until the trained fall/industrial accident model is ready.

HOW TO PLUG IN THE REAL MODEL
------------------------------
1. Train your fall / industrial accident model (YOLO or custom).
2. Save weights to:
       D:\\AwareX\\runs\\awarex_incident_v1\\weights\\best.pt
3. Replace _load_model() with real YOLO loading code.
4. Replace analyze_frame() and analyze_sequence() with actual inference.
5. Keep the return schema identical so the rest of the system needs
   zero changes.

RETURN SCHEMA (always returned, real or placeholder)
-----------------------------------------------------
{
    "incident_detected": bool,       # True only when a real model confirms
    "incident_type":     str | None, # e.g. "fall", "collapse", "fire"
    "confidence":        float,      # 0.0 – 1.0
    "bbox":              list | None,# [x1, y1, x2, y2] in pixels, or None
    "note":              str         # human-readable status
}

ARCHITECTURE NOTE
-----------------
This module is called by AI/live_monitor.py after PPE detection:

    CAMERA FRAME
         ↓
    WorkerTracker           (AI/worker_tracking.py)
         ↓
    ┌────┴────┐
    ↓         ↓
 PPE AI   Incident AI      ← this file
    ↓         ↓
    └────┬────┘
         ↓
    Temporal verification
         ↓
    Safety event
"""

from __future__ import annotations

import os
import logging
from typing import Optional

logger = logging.getLogger("awarex.incident_model")

# ─────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────

MODEL_PATH = os.getenv(
    "INCIDENT_MODEL_PATH",
    r"D:\AwareX\runs\awarex_incident_v1\weights\best.pt",
)

_model_loaded = False
_model = None


def _load_model():
    """
    Attempt to load the incident detection model.
    Returns True if successful, False if the model file does not exist yet.
    """
    global _model_loaded, _model
    if _model_loaded:
        return True
    if not os.path.exists(MODEL_PATH):
        logger.info(
            "Incident model not found at %s — running in placeholder mode.",
            MODEL_PATH,
        )
        return False
    try:
        from ultralytics import YOLO  # type: ignore
        _model = YOLO(MODEL_PATH)
        _model_loaded = True
        logger.info("Incident model loaded from %s", MODEL_PATH)
        return True
    except Exception as exc:
        logger.warning("Failed to load incident model: %s", exc)
        return False


# Attempt load at import time (silent if model absent)
_load_model()


# ─────────────────────────────────────────────────────────────
# Public interface
# ─────────────────────────────────────────────────────────────

def analyze_frame(frame) -> dict:
    """
    Analyze a single frame (numpy array, BGR) for industrial incidents.

    Parameters
    ----------
    frame : np.ndarray
        BGR frame from OpenCV or similar source.

    Returns
    -------
    dict  — see module docstring for schema.
    """
    if not _model_loaded:
        return _placeholder("Model not loaded — placeholder mode active")

    try:
        results = _model.predict(
            source=frame,
            conf=0.40,
            device="cpu",
            verbose=False,
        )
        return _parse_results(results)
    except Exception as exc:
        logger.warning("Incident model inference error: %s", exc)
        return _placeholder("Inference error: " + str(exc))


def analyze_frame_path(frame_path: str) -> dict:
    """
    Analyze a frame given its file path.  Convenience wrapper.
    """
    if not _model_loaded:
        return _placeholder("Model not loaded — placeholder mode active")

    try:
        results = _model.predict(
            source=frame_path,
            conf=0.40,
            device="cpu",
            verbose=False,
        )
        return _parse_results(results)
    except Exception as exc:
        logger.warning("Incident model inference error: %s", exc)
        return _placeholder("Inference error: " + str(exc))


def analyze_sequence(frames: list) -> dict:
    """
    Analyze a sequence of frames for temporally consistent incident detection.
    Returns the highest-confidence result across the sequence, or no-detection
    if nothing consistent is found.

    Parameters
    ----------
    frames : list[np.ndarray]
        Ordered list of BGR frames.
    """
    if not _model_loaded:
        return _placeholder("Model not loaded — placeholder mode active")

    best = _placeholder("No incident detected across sequence")
    for frame in frames:
        result = analyze_frame(frame)
        if result["incident_detected"] and result["confidence"] > best["confidence"]:
            best = result
    return best


def is_ready() -> bool:
    """Return True if the real model is loaded and ready."""
    return _model_loaded


# ─────────────────────────────────────────────────────────────
# Internals
# ─────────────────────────────────────────────────────────────

def _placeholder(note: str = "Placeholder — no real model loaded") -> dict:
    return {
        "incident_detected": False,
        "incident_type":     None,
        "confidence":        0.0,
        "bbox":              None,
        "note":              note,
    }


def _parse_results(results) -> dict:
    """Convert YOLO results to the standard incident schema."""
    if not results:
        return _placeholder("No YOLO results returned")

    result = results[0]
    boxes  = result.boxes

    if boxes is None or len(boxes) == 0:
        return _placeholder("No incident detected")

    # Take highest-confidence detection
    best_conf  = 0.0
    best_cls   = None
    best_bbox  = None

    for box in boxes:
        conf     = float(box.conf[0])
        class_id = int(box.cls[0])
        cls_name = result.names.get(class_id, str(class_id))
        bbox     = [round(x) for x in box.xyxy[0].tolist()]

        if conf > best_conf:
            best_conf  = conf
            best_cls   = cls_name
            best_bbox  = bbox

    if best_cls is None:
        return _placeholder("No incident detected")

    return {
        "incident_detected": True,
        "incident_type":     best_cls,
        "confidence":        round(best_conf, 3),
        "bbox":              best_bbox,
        "note":              f"Detected by trained incident model: {best_cls}",
    }
