"""
AwareX Incident / Fall Detection Model
========================================
Wraps the trained fall-detection YOLO model.

Model priority (first existing path wins):
  1. INCIDENT_MODEL_PATH env var
  2. awarex_fall_fast/weights/best.pt      (newest training run)
  3. awarex_fall_detector_v1/weights/best.pt
  4. awarex_fall_v1/weights/best.pt

If no model file is found, runs in safe placeholder mode (no fake detections).

Return schema (always):
  {
    "incident_detected": bool,
    "incident_type":     str | None,   e.g. "fall", "violence"
    "confidence":        float,        0.0 – 1.0
    "bbox":              list | None,  [x1, y1, x2, y2]
    "note":              str
  }
"""

from __future__ import annotations

import os
import logging
from pathlib import Path
import torch

logger = logging.getLogger("awarex.incident_model")

# ─────────────────────────────────────────────────────────────
# Device
# ─────────────────────────────────────────────────────────────

_DEVICE: int | str = 0 if torch.cuda.is_available() else "cpu"

# ─────────────────────────────────────────────────────────────
# Model path resolution
# ─────────────────────────────────────────────────────────────

_CANDIDATE_PATHS = [
    os.getenv("INCIDENT_MODEL_PATH", ""),
    str(Path(__file__).resolve().parent.parent / "runs" / "awarex_fall_fast" / "weights" / "best.pt"),
    str(Path(__file__).resolve().parent.parent / "runs" / "awarex_fall_detector_v1" / "weights" / "best.pt"),
    str(Path(__file__).resolve().parent.parent / "runs" / "awarex_fall_v1" / "weights" / "best.pt"),
    str(Path(__file__).resolve().parent.parent / "runs" / "awarex_fall_detector_v2" / "weights" / "best.pt"),
    str(Path(__file__).resolve().parent.parent / "runs" / "awarex_fall_detector_v2-2" / "weights" / "best.pt"),
]

MODEL_PATH: str = ""
for _p in _CANDIDATE_PATHS:
    if _p and os.path.exists(_p):
        MODEL_PATH = _p
        break

_model_loaded = False
_model = None


def _load_model() -> bool:
    global _model_loaded, _model
    if _model_loaded:
        return True
    if not MODEL_PATH:
        logger.info("[IncidentModel] no weights found — placeholder mode")
        return False
    try:
        from ultralytics import YOLO
        _model = YOLO(MODEL_PATH)
        _model_loaded = True
        logger.info("[IncidentModel] loaded %s  device=%s", MODEL_PATH, _DEVICE)
        return True
    except Exception as exc:
        logger.warning("[IncidentModel] load failed: %s", exc)
        return False


_load_model()


# ─────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────

def analyze_frame(frame) -> dict:
    """Analyze a numpy BGR frame."""
    if not _model_loaded:
        return _placeholder("Incident model not loaded")
    try:
        results = _model.predict(source=frame, conf=0.40, device=_DEVICE, verbose=False)
        return _parse_results(results)
    except Exception as exc:
        logger.warning("[IncidentModel] inference error: %s", exc)
        return _placeholder(f"Inference error: {exc}")


def analyze_frame_path(frame_path: str) -> dict:
    """Analyze a frame by file path.  Kept for backward compatibility."""
    if not _model_loaded:
        return _placeholder("Incident model not loaded")
    try:
        results = _model.predict(source=frame_path, conf=0.40, device=_DEVICE, verbose=False)
        return _parse_results(results)
    except Exception as exc:
        logger.warning("[IncidentModel] inference error: %s", exc)
        return _placeholder(f"Inference error: {exc}")


def analyze_sequence(frames: list) -> dict:
    best = _placeholder("No incident in sequence")
    for f in frames:
        r = analyze_frame(f)
        if r["incident_detected"] and r["confidence"] > best["confidence"]:
            best = r
    return best


def is_ready() -> bool:
    return _model_loaded


def get_model_path() -> str:
    return MODEL_PATH or "not loaded"


# ─────────────────────────────────────────────────────────────
# Internals
# ─────────────────────────────────────────────────────────────

def _placeholder(note: str) -> dict:
    return {
        "incident_detected": False,
        "incident_type":     None,
        "confidence":        0.0,
        "bbox":              None,
        "note":              note,
    }


def _parse_results(results) -> dict:
    if not results:
        return _placeholder("No results")
    result = results[0]
    boxes = result.boxes
    if boxes is None or len(boxes) == 0:
        return _placeholder("No incident detected")

    best_conf, best_cls, best_bbox = 0.0, None, None
    for box in boxes:
        conf = float(box.conf[0])
        cls_name = result.names.get(int(box.cls[0]), str(int(box.cls[0])))
        if conf > best_conf:
            best_conf = conf
            best_cls  = cls_name
            best_bbox = [round(x) for x in box.xyxy[0].tolist()]

    if best_cls is None:
        return _placeholder("No incident detected")

    return {
        "incident_detected": True,
        "incident_type":     best_cls,
        "confidence":        round(best_conf, 3),
        "bbox":              best_bbox,
        "note":              f"Detected: {best_cls}",
    }
