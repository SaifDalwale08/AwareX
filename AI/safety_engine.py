# ============================================
# AwareX Safety Intelligence Engine
# ============================================

VIOLATION_CLASSES = {
    "no-helmet": "Helmet violation",
    "no-vest": "Safety vest violation",
    "no-gloves": "Gloves violation",
    "no-goggles": "Safety goggles violation",
    "no-boots": "Safety boots violation",
}

CRITICAL_VIOLATIONS = {
    "no-helmet",
    "no-vest",
}


def analyze_safety(detections):
    """
    Convert YOLO detections into AwareX safety intelligence.
    """

    total_detections = len(detections)

    violations = []

    for detection in detections:

        class_name = detection["class"]

        if class_name in VIOLATION_CLASSES:

            violations.append({
                "type": class_name,
                "description": VIOLATION_CLASSES[class_name],
                "confidence": detection["confidence"],
                "bbox": detection["bbox"]
            })

    violation_count = len(violations)

    # ----------------------------------------
    # Safety Score
    # ----------------------------------------

    if total_detections == 0:
        safety_score = 100

    else:
        safety_score = (
            (total_detections - violation_count)
            / total_detections
        ) * 100

        safety_score = max(0, round(safety_score, 2))

    # ----------------------------------------
    # Severity
    # ----------------------------------------

    critical_count = sum(
        1
        for violation in violations
        if violation["type"] in CRITICAL_VIOLATIONS
    )

    if critical_count > 0:
        severity = "CRITICAL"

    elif violation_count > 0:
        severity = "WARNING"

    else:
        severity = "SAFE"

    # ----------------------------------------
    # Recommendation
    # ----------------------------------------

    if severity == "CRITICAL":

        recommendation = (
            "Immediate safety intervention recommended. "
            "Critical PPE violations detected."
        )

    elif severity == "WARNING":

        recommendation = (
            "Safety officer attention recommended. "
            "PPE compliance issue detected."
        )

    else:

        recommendation = (
            "No immediate PPE intervention required."
        )

    return {
        "safety_score": safety_score,
        "total_detections": total_detections,
        "violation_count": violation_count,
        "critical_violations": critical_count,
        "severity": severity,
        "violations": violations,
        "recommendation": recommendation
    }