"""
AwareX Notification Service
============================
Sends manager alerts when critical safety violations are detected.

Supported providers (configured via .env):
  - Twilio SMS  (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, MANAGER_PHONE)
  - WhatsApp via Twilio (TWILIO_WHATSAPP_FROM, MANAGER_WHATSAPP)
  - Generic webhook  (ALERT_WEBHOOK_URL)

If no provider credentials are present the service runs in MOCK mode:
  - Alerts are logged to stdout and to   logs/alerts.log
  - No real messages are sent
  - The response clearly states "MOCK MODE"
"""

import os
import json
import logging
from datetime import datetime
from pathlib import Path

# ─────────────────────────────────────────────
# Logger
# ─────────────────────────────────────────────

LOG_DIR = Path(__file__).parent.parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("awarex.notifications")

_file_handler = logging.FileHandler(
    LOG_DIR / "alerts.log", encoding="utf-8"
)
_file_handler.setFormatter(
    logging.Formatter("%(asctime)s  %(levelname)s  %(message)s")
)
logger.addHandler(_file_handler)


# ─────────────────────────────────────────────
# Alert message builder
# ─────────────────────────────────────────────

def build_alert_message(
    violation: str,
    worker_id: str,
    zone: str,
    camera: str,
    severity: str,
    confidence: float,
    recommendation: str = "",
) -> str:
    now = datetime.now().strftime("%I:%M %p")
    conf_pct = round(confidence * 100) if confidence <= 1 else round(confidence)
    return (
        f"🚨 AwareX Critical Safety Alert\n"
        f"Violation: {violation}\n"
        f"Worker: {worker_id}\n"
        f"Zone: {zone}\n"
        f"Camera: {camera}\n"
        f"Severity: {severity}\n"
        f"Confidence: {conf_pct}%\n"
        f"Time: {now}\n"
        f"{recommendation or 'Immediate PPE compliance intervention recommended.'}"
    )


# ─────────────────────────────────────────────
# Provider: Twilio SMS
# ─────────────────────────────────────────────

def _send_twilio_sms(message: str) -> dict:
    sid = os.getenv("TWILIO_ACCOUNT_SID", "")
    token = os.getenv("TWILIO_AUTH_TOKEN", "")
    from_number = os.getenv("TWILIO_FROM", "")
    to_number = os.getenv("MANAGER_PHONE", "")

    if not all([sid, token, from_number, to_number]):
        return {"provider": "twilio_sms", "status": "skipped", "reason": "credentials missing"}

    try:
        from twilio.rest import Client  # type: ignore
        client = Client(sid, token)
        msg = client.messages.create(
            body=message,
            from_=from_number,
            to=to_number,
        )
        return {
            "provider": "twilio_sms",
            "status": "sent",
            "sid": msg.sid,
            "to": to_number,
        }
    except ImportError:
        return {"provider": "twilio_sms", "status": "skipped", "reason": "twilio package not installed"}
    except Exception as exc:
        return {"provider": "twilio_sms", "status": "error", "error": str(exc)}


# ─────────────────────────────────────────────
# Provider: Twilio WhatsApp
# ─────────────────────────────────────────────

def _send_twilio_whatsapp(message: str) -> dict:
    sid = os.getenv("TWILIO_ACCOUNT_SID", "")
    token = os.getenv("TWILIO_AUTH_TOKEN", "")
    from_wa = os.getenv("TWILIO_WHATSAPP_FROM", "")  # e.g. whatsapp:+14155238886
    to_wa = os.getenv("MANAGER_WHATSAPP", "")         # e.g. whatsapp:+919876543210

    if not all([sid, token, from_wa, to_wa]):
        return {"provider": "twilio_whatsapp", "status": "skipped", "reason": "credentials missing"}

    try:
        from twilio.rest import Client  # type: ignore
        client = Client(sid, token)
        msg = client.messages.create(
            body=message,
            from_=from_wa,
            to=to_wa,
        )
        return {
            "provider": "twilio_whatsapp",
            "status": "sent",
            "sid": msg.sid,
            "to": to_wa,
        }
    except ImportError:
        return {"provider": "twilio_whatsapp", "status": "skipped", "reason": "twilio package not installed"}
    except Exception as exc:
        return {"provider": "twilio_whatsapp", "status": "error", "error": str(exc)}


# ─────────────────────────────────────────────
# Provider: Generic Webhook (Slack / Teams / etc.)
# ─────────────────────────────────────────────

def _send_webhook(message: str, violation_data: dict) -> dict:
    url = os.getenv("ALERT_WEBHOOK_URL", "")
    if not url:
        return {"provider": "webhook", "status": "skipped", "reason": "ALERT_WEBHOOK_URL not set"}

    try:
        import urllib.request
        payload = json.dumps({
            "text": message,
            "violation": violation_data,
        }).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return {
                "provider": "webhook",
                "status": "sent",
                "http_status": resp.status,
            }
    except Exception as exc:
        return {"provider": "webhook", "status": "error", "error": str(exc)}


# ─────────────────────────────────────────────
# Provider: TextBee SMS
# https://textbee.dev  — simple REST API, no SDK required
# ─────────────────────────────────────────────

def _send_textbee_sms(message: str) -> dict:
    """
    Send SMS via TextBee REST API.
    Requires:
        TEXTBEE_API_KEY        — API key from textbee.dev dashboard
        TEXTBEE_MANAGER_PHONE  — recipient number in E.164 format (+91XXXXXXXXXX)
    """
    api_key = os.getenv("TEXTBEE_API_KEY", "").strip()
    to_phone = os.getenv("TEXTBEE_MANAGER_PHONE", "").strip()

    if not api_key or not to_phone:
        return {
            "provider": "textbee",
            "status":   "skipped",
            "reason":   "TEXTBEE_API_KEY or TEXTBEE_MANAGER_PHONE not set",
        }

    try:
        import urllib.request
        import urllib.error

        payload = json.dumps({
            "receivers": [to_phone],
            "message":   message,
        }).encode("utf-8")

        req = urllib.request.Request(
            "https://api.textbee.dev/api/v1/gateway/devices/send-sms",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "x-api-key":    api_key,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            return {
                "provider":    "textbee",
                "status":      "sent",
                "http_status": resp.status,
                "to":          to_phone,
                "response":    body[:200],
            }
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8")[:300]
        except Exception:
            pass
        return {
            "provider": "textbee",
            "status":   "error",
            "error":    f"HTTP {exc.code}: {body}",
        }
    except Exception as exc:
        return {
            "provider": "textbee",
            "status":   "error",
            "error":    str(exc),
        }


# ─────────────────────────────────────────────
# Mock mode (always runs when no providers fire)
# ─────────────────────────────────────────────

def _log_mock(message: str, violation_data: dict) -> dict:
    logger.warning("MOCK ALERT:\n%s\nData: %s", message, json.dumps(violation_data, indent=2))
    return {"provider": "mock", "status": "logged", "mode": "MOCK — no real message sent"}


# ─────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────

def send_critical_alert(
    violation: str,
    worker_id: str,
    zone: str,
    camera: str,
    severity: str,
    confidence: float,
    recommendation: str = "",
) -> dict:
    """
    Send a critical safety alert through all configured providers.
    Always returns a summary dict describing what happened.
    """
    message = build_alert_message(
        violation=violation,
        worker_id=worker_id,
        zone=zone,
        camera=camera,
        severity=severity,
        confidence=confidence,
        recommendation=recommendation,
    )

    violation_data = {
        "violation": violation,
        "worker_id": worker_id,
        "zone": zone,
        "camera": camera,
        "severity": severity,
        "confidence": confidence,
        "timestamp": datetime.now().isoformat(),
    }

    results = []
    any_sent = False

    # TextBee SMS (primary for this deployment)
    tb_result = _send_textbee_sms(message)
    results.append(tb_result)
    if tb_result.get("status") == "sent":
        any_sent = True

    # Try every additional provider
    sms_result = _send_twilio_sms(message)
    results.append(sms_result)
    if sms_result.get("status") == "sent":
        any_sent = True

    wa_result = _send_twilio_whatsapp(message)
    results.append(wa_result)
    if wa_result.get("status") == "sent":
        any_sent = True

    wh_result = _send_webhook(message, violation_data)
    results.append(wh_result)
    if wh_result.get("status") == "sent":
        any_sent = True

    # Mock fallback
    if not any_sent:
        results.append(_log_mock(message, violation_data))

    return {
        "alert_sent": any_sent,
        "mock_mode": not any_sent,
        "message_preview": message,
        "providers": results,
        "timestamp": datetime.now().isoformat(),
    }
