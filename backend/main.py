import os
import shutil
import tempfile

import cv2

from dotenv import load_dotenv
from supabase import create_client, Client

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ==========================================
# Environment
# ==========================================

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY")
VIDEO_FRAME_INTERVAL = int(os.getenv("VIDEO_FRAME_INTERVAL", "10"))

if not SUPABASE_URL or not SUPABASE_SECRET_KEY:
    raise RuntimeError("Supabase credentials not found in .env")

# ==========================================
# Supabase
# ==========================================

supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY
)

# ==========================================
# AwareX AI
# ==========================================

from AI.inference import analyze_image
from AI.safety_engine import analyze_safety

# ==========================================
# FastAPI
# ==========================================

app = FastAPI(title="AwareX Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:8000",
        "http://localhost:8000"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==========================================
# Request model
# ==========================================

class AnalyzeRequest(BaseModel):
    image_path: str
    camera: str = "Camera-01"
    zone: str = "Zone-A"


# ==========================================
# Root
# ==========================================

@app.get("/")
def root():

    return {
        "system": "AwareX",
        "status": "online"
    }


# ==========================================
# AI ANALYSIS
# ==========================================

@app.post("/api/analyze-image")
def analyze_image_endpoint(request: AnalyzeRequest):

    # --------------------------------------
    # Run YOLO
    # --------------------------------------

    detections = analyze_image(request.image_path)

    # --------------------------------------
    # Safety Intelligence
    # --------------------------------------

    safety_result = analyze_safety(detections)

    # --------------------------------------
    # Store violations in Supabase
    # --------------------------------------

    stored_events = []

    for violation in safety_result["violations"]:

        event = {
            "camera": request.camera,
            "zone": request.zone,
            "violation": violation["type"],
            "confidence": violation["confidence"],
            "severity": safety_result["severity"],
            "recommendation": safety_result["recommendation"],
            "status": "OPEN"
        }

        response = (
            supabase
            .table("safety_events")
            .insert(event)
            .execute()
        )

        stored_events.extend(response.data)

    # --------------------------------------
    # Return complete AwareX result
    # --------------------------------------

    return {
        "success": True,

        "camera": request.camera,

        "zone": request.zone,

        "detections": detections,

        "safety": safety_result,

        "stored_events": stored_events
    }


@app.post("/api/analyze")
def analyze_video(
    video: UploadFile = File(...),
    camera: str = Form("Camera-01"),
    zone: str = Form("Zone-A")
):

    if not video.filename:
        raise HTTPException(
            status_code=400,
            detail="Video file is required."
        )

    file_ext = os.path.splitext(video.filename)[1].lower()
    if file_ext not in (".mp4", ".mov", ".avi", ".webm", ".mkv"):
        raise HTTPException(
            status_code=400,
            detail="Unsupported video format. Use MP4, MOV, AVI, WEBM, or MKV."
        )

    temp_dir = tempfile.mkdtemp(prefix="awarex_video_")
    upload_path = os.path.join(temp_dir, video.filename)

    try:
        with open(upload_path, "wb") as out_file:
            shutil.copyfileobj(video.file, out_file)

        capture = cv2.VideoCapture(upload_path)
        if not capture.isOpened():
            raise HTTPException(
                status_code=400,
                detail="Unable to open uploaded video."
            )

        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

        sampled_frames = 0
        frames_processed = 0
        all_detections = []

        frame_index = 0
        while True:
            ret, frame = capture.read()
            if not ret:
                break

            frames_processed += 1
            frame_index += 1

            if frame_index != 1 and frame_index % VIDEO_FRAME_INTERVAL != 0:
                continue

            sampled_frames += 1
            frame_file = os.path.join(temp_dir, f"frame_{frame_index}.jpg")
            if not cv2.imwrite(frame_file, frame):
                raise HTTPException(
                    status_code=500,
                    detail="Failed to write temporary frame image."
                )

            try:
                frame_detections = analyze_image(frame_file)
            except Exception as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"YOLO failure: {exc}"
                )
            finally:
                try:
                    os.remove(frame_file)
                except OSError:
                    pass

            all_detections.extend(frame_detections)

        capture.release()

        if frames_processed == 0:
            raise HTTPException(
                status_code=400,
                detail="Uploaded video contains no readable frames."
            )

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
                "violation": violation["type"],
                "camera": camera,
                "zone": zone,
                "confidence": violation["confidence"],
                "severity": severity,
                "recommendation": safety_result["recommendation"],
                "status": "OPEN"
            })

        stored_events = []
        if deduped_violations:
            response = (
                supabase
                .table("safety_events")
                .insert(deduped_violations)
                .execute()
            )

            if getattr(response, "error", None):
                raise HTTPException(
                    status_code=500,
                    detail=f"Supabase insert failed: {response.error}"
                )

            stored_events = response.data or []

        return {
            "success": True,
            "video": {
                "name": video.filename,
                "size": os.path.getsize(upload_path),
                "duration": round(frame_count / fps, 2) if fps else None,
                "frames": frame_count,
                "sampled_frames": sampled_frames,
                "fps": fps
            },
            "frames_processed": frames_processed,
            "sampled_frames": sampled_frames,
            "total_detections": safety_result["total_detections"],
            "violations": deduped_violations,
            "critical_violations": safety_result["critical_violations"],
            "safety_score": safety_result["safety_score"],
            "severity": safety_result["severity"],
            "recommendations": [safety_result["recommendation"]],
            "stored_events": stored_events
        }

    finally:
        try:
            shutil.rmtree(temp_dir)
        except OSError:
            pass


@app.get("/api/dashboard-data")
def get_dashboard_data():

    response = (
        supabase
        .table("safety_events")
        .select("*")
        .order("created_at", desc=True)
        .execute()
    )

    if getattr(response, "error", None):
        return {
            "success": False,
            "message": str(response.error),
            "total_events": 0,
            "critical_events": 0,
            "events": []
        }

    events = response.data or []

    critical_count = sum(
        1 for event in events
        if str(event.get("severity", "")).upper() == "CRITICAL"
    )

    return {
        "success": True,
        "total_events": len(events),
        "critical_events": critical_count,
        "events": events
    }