from AI.safety_engine import analyze_safety
from ultralytics import YOLO
from pathlib import Path
import json


# ==============================
# AwareX AI Configuration
# ==============================

MODEL_PATH = r"D:\AwareX\runs\awarex_ppe_v1\weights\best.pt"

model = YOLO(MODEL_PATH)


def analyze_image(image_path):
    """
    Run AwareX PPE detection on a single image.
    """

    results = model.predict(
        source=image_path,
        conf=0.35,
        device="cpu",
        verbose=False
    )

    detections = []

    for result in results:

        boxes = result.boxes

        if boxes is None:
            continue

        for box in boxes:

            class_id = int(box.cls[0])
            confidence = float(box.conf[0])

            class_name = model.names[class_id]

            x1, y1, x2, y2 = box.xyxy[0].tolist()

            detections.append({
                "class": class_name,
                "confidence": round(confidence, 3),
                "bbox": [
                    round(x1),
                    round(y1),
                    round(x2),
                    round(y2)
                ]
            })

    return detections


def generate_summary(detections):

    summary = {}

    for detection in detections:

        class_name = detection["class"]

        if class_name not in summary:
            summary[class_name] = 0

        summary[class_name] += 1

    return summary


if __name__ == "__main__":

    print("===================================")
    print("        AwareX AI ENGINE")
    print("===================================")

    print("\nModel:", MODEL_PATH)

    print("\nAvailable Classes:")

    for class_id, name in model.names.items():
        print(f"{class_id}: {name}")

    print("\nAI Engine loaded successfully.")

    # ==========================================
    # Find a real test image automatically
    # ==========================================

    test_folder = Path(r"D:\AwareX\dataset\test\images")

    image_files = list(test_folder.glob("*.jpg"))

    if not image_files:
        image_files = list(test_folder.glob("*.png"))

    if not image_files:
        print("\nERROR: No test images found.")
        exit()

    test_image = str(image_files[0])

    print("\nTest image:")
    print(test_image)

    # ==========================================
    # Run YOLO detection
    # ==========================================

    print("\nRunning AI detection...")

    detections = analyze_image(test_image)

    # ==========================================
    # Display detections
    # ==========================================

    print("\nDetections:")

    if not detections:
        print("  No PPE detected.")

    else:

        for detection in detections:

            print(
                f"  {detection['class']} "
                f"({detection['confidence']})"
            )

    # ==========================================
    # AwareX Safety Intelligence
    # ==========================================

    safety_result = analyze_safety(detections)

    print("\n===================================")
    print("     AWAREX SAFETY INTELLIGENCE")
    print("===================================")

    print(
        f"\nSafety Score: "
        f"{safety_result['safety_score']}%"
    )

    print(
        f"Total Detections: "
        f"{safety_result['total_detections']}"
    )

    print(
        f"PPE Violations: "
        f"{safety_result['violation_count']}"
    )

    print(
        f"Critical Violations: "
        f"{safety_result['critical_violations']}"
    )

    print(
        f"Severity: "
        f"{safety_result['severity']}"
    )

    print(
        f"\nRecommendation:\n"
        f"{safety_result['recommendation']}"
    )