"""
AwareX PPE Inference
=====================
Runs the AwareX custom PPE YOLO model on a single image.

Device selection:
  - Uses GPU (device=0) when CUDA is available.
  - Falls back to CPU automatically.

Model path:
  - Reads PPE_MODEL_PATH env var first.
  - Falls back to the default trained weights path.
"""

import os
import logging
import torch

from ultralytics import YOLO

logger = logging.getLogger("awarex.inference")

# ── Device ───────────────────────────────────────────────────
_DEVICE: int | str = 0 if torch.cuda.is_available() else "cpu"

# ── Model path ───────────────────────────────────────────────
_DEFAULT_MODEL_PATH = r"D:\AwareX\runs\awarex_ppe_v1\weights\best.pt"
MODEL_PATH = os.getenv("PPE_MODEL_PATH", _DEFAULT_MODEL_PATH)

# ── Load model once at import time ───────────────────────────
if not os.path.exists(MODEL_PATH):
    raise FileNotFoundError(
        f"AwareX PPE model not found at: {MODEL_PATH}\n"
        f"Set the PPE_MODEL_PATH environment variable to the correct path."
    )

model = YOLO(MODEL_PATH)

logger.info(
    "[PPE inference] model=%s  device=%s  classes=%s",
    MODEL_PATH, _DEVICE, list(model.names.values()),
)


# ── Public API ────────────────────────────────────────────────

def analyze_image(image_path: str) -> list:
    """
    Run AwareX PPE detection on a single image file.

    Parameters
    ----------
    image_path : str
        Path to a JPEG/PNG image.

    Returns
    -------
    list of dicts:
        { "class": str, "confidence": float, "bbox": [x1,y1,x2,y2] }
    """
    results = model.predict(
        source=image_path,
        conf=0.35,
        device=_DEVICE,
        verbose=False,
    )
    return _parse_boxes(results)


def analyze_numpy(frame) -> list:
    """
    Run AwareX PPE detection on an already-decoded numpy BGR frame.
    Avoids the disk write/read roundtrip used by analyze_image().
    """
    results = model.predict(
        source=frame,
        conf=0.35,
        device=_DEVICE,
        verbose=False,
    )
    return _parse_boxes(results)


def _parse_boxes(results) -> list:
    detections = []
    for result in results:
        boxes = result.boxes
        if boxes is None:
            continue
        for box in boxes:
            class_id   = int(box.cls[0])
            confidence = float(box.conf[0])
            class_name = model.names[class_id]
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            detections.append({
                "class":      class_name,
                "confidence": round(confidence, 3),
                "bbox":       [round(x1), round(y1), round(x2), round(y2)],
            })
    return detections


def generate_summary(detections: list) -> dict:
    """Count detections by class name."""
    summary: dict = {}
    for d in detections:
        cls = d["class"]
        summary[cls] = summary.get(cls, 0) + 1
    return summary


def get_device() -> str:
    """Return the device string currently used for inference."""
    return str(_DEVICE)


# ── Standalone test ──────────────────────────────────────────
if __name__ == "__main__":
    from pathlib import Path
    from AI.safety_engine import analyze_safety

    print("=" * 50)
    print("AwareX PPE Inference — standalone test")
    print("=" * 50)
    print(f"Model: {MODEL_PATH}")
    print(f"Device: {_DEVICE}")
    print(f"Classes: {list(model.names.values())}")

    # Find a test image
    test_dirs = [
        Path(r"D:\AwareX\Dataset\test\images"),
        Path(r"D:\AwareX\dataset\test\images"),
    ]
    image = None
    for d in test_dirs:
        imgs = list(d.glob("*.jpg")) if d.exists() else []
        if imgs:
            image = imgs[0]
            break

    if image is None:
        print("No test images found.")
    else:
        print(f"Test image: {image}")
        detections = analyze_image(str(image))
        print(f"Detections: {len(detections)}")
        for det in detections:
            print(f"  {det['class']}  conf={det['confidence']}")

        safety = analyze_safety(detections)
        print(f"Safety score: {safety['safety_score']}%  severity={safety['severity']}")
