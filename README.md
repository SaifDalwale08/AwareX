# AwareX

## AI-Powered Workplace Safety Monitoring System

AwareX is an AI-powered workplace safety monitoring system that analyzes images and videos to detect PPE compliance violations and generate safety insights.

## 🚀 Current MVP

- PPE detection using YOLO
- Image analysis
- Video analysis
- OpenCV-based frame processing
- PPE violation detection
- Safety severity classification
- Safety score generation
- Violation aggregation and deduplication
- Supabase safety-event storage
- FastAPI backend
- Web-based monitoring dashboard
- Drag-and-drop video analysis

## 🧠 Architecture

```text
Video / Image
      ↓
    OpenCV
      ↓
   YOLO Model
      ↓
 Safety Engine
      ↓
   FastAPI
      ↓
   Supabase
      ↓
 AwareX Dashboard

🎥 Video Analysis

The video pipeline processes uploaded videos using OpenCV and samples frames for YOLO inference.

Video
  ↓
OpenCV
  ↓
Frame Sampling
  ↓
YOLO Detection
  ↓
Safety Engine
  ↓
Violation Aggregation
  ↓
Supabase
  ↓
Dashboard

##Verified Test

A real 7.21-second video was successfully processed:

| Metric              | Result |
| ------------------- | -----: |
| Total frames        |    216 |
| Sampled frames      |     22 |
| YOLO detections     |     52 |
| Violations          |      0 |
| Critical violations |      0 |
| Safety score        |    100 |
| Severity            |   SAFE |


##🛡️ Safety Engine

The Safety Engine converts AI detections into safety information including:

Safety score
Violation count
Critical violation count
Severity
Recommendations
Stored safety events

Supported PPE violation classes include:

no-helmet
no-vest
no-goggles
no-boots
no-gloves

## Deployment

The FastAPI application object is `backend.main:app`. A Render-compatible start command is:

```text
uvicorn backend.main:app --host 0.0.0.0 --port $PORT
```

Copy `.env.example` to `.env` locally or configure the same variables in the deployment provider. Set `CORS_ORIGINS` to a comma-separated list containing the deployed frontend origin; the default keeps `127.0.0.1:8000` and `localhost:8000` available for local development. The existing `GET /api/system-status` endpoint can be used as a health check.

The local SQLite journal is created automatically at `data/awarex_local.db` when the backend starts. Deployment filesystems may be ephemeral, so this journal is not permanent storage; Supabase remains the persistent store where applicable.

Model weights are intentionally excluded from Git. PPE inference requires a file configured by `PPE_MODEL_PATH` (or the repository-relative training output), worker tracking requires `WORKER_MODEL_PATH` or `yolov8n.pt`, and incident detection uses `INCIDENT_MODEL_PATH` when supplied. Provide the required weights through the deployment environment or attached storage; this project does not invent a download URL.

⚡ Backend

AwareX uses FastAPI for AI processing and API communication.

API Endpoints
POST /api/analyze
POST /api/analyze-image
GET  /api/dashboard-data

Swagger documentation:

http://127.0.0.1:8002/docs

📊 Dashboard

The AwareX dashboard provides:

Video upload
AI analysis
Safety score
Active alerts
Critical violations
Recent safety events
Backend-connected dashboard data

Local dashboard:

http://127.0.0.1:8000/dashboard.html

🗄️ Database

Supabase is used to store safety events.

The main table is:

safety_events

Stored information includes:

Camera
Zone
Violation
Confidence
Severity
Recommendation
Status
Timestamp

📁 Project Structure
AwareX/
│
├── AI/
│   ├── __init__.py
│   ├── inference.py
│   └── safety_engine.py
│
├── backend/
│   └── main.py
│
├── frontend/
│   ├── dashboard.html
│   └── js/
│       ├── auth.js
│       ├── dashboard-data.js
│       ├── dashboard.js
│       ├── main.js
│       ├── navigation.js
│       └── tailwind-config.js
│
├── .gitignore
└── README.md
⚙️ Running Locally
Backend

From the project root:

python -m uvicorn backend.main:app --port 8002
Frontend

From the frontend directory:

powershell -ExecutionPolicy Bypass -File run-server.ps1

Then open:

http://127.0.0.1:8000/dashboard.html
🔐 Security

Sensitive files and large generated files are excluded using .gitignore.

These include:

.env
venv/
datasets
YOLO model weights
training outputs
uploaded videos
temporary files

Never commit Supabase credentials or API keys to GitHub.

🚧 Future Development

Planned improvements:

Real-time camera monitoring
Worker tracking
Persistent violation detection
Annotated video output
Violation timelines
Advanced safety analytics
Camera and zone filtering
Real-time alerts
Automated safety reports
Cloud deployment

🎯 Project Status

AwareX MVP — Working

The current system successfully demonstrates:

Video Upload
     ↓
YOLO Detection
     ↓
Safety Intelligence
     ↓
FastAPI
     ↓
Supabase
     ↓
Dashboard

Built as an AI-powered workplace safety monitoring solution.


### 2. Save it

Press:

**`Ctrl + S`**

### 3. Then come back to PowerShell

You're in:

```text
D:\AwareX


