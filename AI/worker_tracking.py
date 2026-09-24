"""
AwareX Worker Tracker
======================
Wraps YOLO person detection + ByteTrack tracking.

Key design decisions:
  - Device is selected once at instantiation and passed explicitly to every
    call — prevents CUDA context mismatch errors between calls.
  - reset() destroys the old YOLO model and creates a fresh one so tracker
    state (ByteTrack / BoTSORT ID counters) is cleanly zeroed before every
    new video.  For live-camera use, do NOT call reset() between frames.
  - Track IDs are integers when available; None only on the very first
    frame before ByteTrack can form a reliable trajectory.  Callers must
    handle None gracefully.
"""

import logging
import torch
from ultralytics import YOLO

logger = logging.getLogger("awarex.worker_tracking")


def _select_device() -> int | str:
    """Return 0 (first CUDA GPU) if CUDA is available, else 'cpu'."""
    return 0 if torch.cuda.is_available() else "cpu"


class WorkerTracker:
    """
    Generic YOLO-based worker / person tracker.

    Parameters
    ----------
    model_path : str
        Path to YOLO weights.  Defaults to yolov8n.pt (nano pretrained,
        good generic person detector).  Set WORKER_MODEL_PATH env var to
        override.
    device : int | str | None
        Inference device.  None = auto-select (CUDA if available, else CPU).
    """

    def __init__(self, model_path: str = "yolov8n.pt", device=None):
        import os
        model_path = os.getenv("WORKER_MODEL_PATH", model_path)
        self._model_path = model_path
        self._device = device if device is not None else _select_device()
        self._load_model()
        logger.info(
            "[WorkerTracker] loaded model=%s  device=%s",
            self._model_path, self._device,
        )

    def _load_model(self):
        self.model = YOLO(self._model_path)

    # ── Public API ────────────────────────────────────────────

    def track_frame(self, frame) -> list:
        """
        Run person detection + tracking on one frame.

        Parameters
        ----------
        frame : np.ndarray   BGR image from OpenCV.

        Returns
        -------
        list of dicts:
            { "track_id": int | None, "confidence": float, "bbox": [x1,y1,x2,y2] }
        """
        try:
            results = self.model.track(
                source=frame,
                persist=True,       # maintain ByteTrack state across consecutive calls
                classes=[0],        # class 0 = person in COCO
                conf=0.30,
                iou=0.45,
                device=self._device,
                verbose=False,
            )
        except Exception as exc:
            # If CUDA context is stale (NMS error etc.), reload model on CPU and retry
            err_str = str(exc).lower()
            if "nms" in err_str or "cuda" in err_str or "torchvision" in err_str:
                logger.warning(
                    "[WorkerTracker] CUDA/NMS error — falling back to CPU: %s", exc
                )
                self._device = "cpu"
                self._load_model()
                results = self.model.track(
                    source=frame,
                    persist=True,
                    classes=[0],
                    conf=0.30,
                    iou=0.45,
                    device=self._device,
                    verbose=False,
                )
            else:
                raise

        workers = []

        if not results:
            return workers

        result = results[0]

        if result.boxes is None:
            return workers

        boxes = result.boxes

        for i in range(len(boxes)):
            confidence = float(boxes.conf[i])
            bbox       = boxes.xyxy[i].tolist()
            track_id   = None

            if boxes.id is not None:
                track_id = int(boxes.id[i])

            workers.append({
                "track_id":   track_id,
                "confidence": confidence,
                "bbox":       bbox,
            })

        return workers

    def reset(self) -> None:
        """
        Reset all tracker state.  Call before processing a new, unrelated video.
        Resets ByteTrack internal counters without reloading weights from disk.
        """
        logger.info("[WorkerTracker] resetting tracker state for new video")
        # Reset ByteTrack/BoTSORT state by calling predict once on a blank frame
        # (cheaper than reloading weights — avoids disk I/O and GPU re-init)
        try:
            import numpy as np
            blank = np.zeros((64, 64, 3), dtype="uint8")
            self.model.track(
                source=blank,
                persist=False,
                classes=[0],
                conf=0.99,   # nothing will be detected on a blank frame
                device=self._device,
                verbose=False,
            )
        except Exception:
            # If that fails for any reason, fall back to full reload
            self._load_model()

    @property
    def device(self):
        return self._device
