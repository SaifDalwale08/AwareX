from ultralytics import YOLO


class WorkerTracker:

    def __init__(self, model_path="yolov8n.pt"):

        self.model = YOLO(model_path)

    def track_frame(self, frame):

        results = self.model.track(
            source=frame,
            persist=True,
            classes=[0],
            conf=0.30,
            iou=0.50,
            verbose=False
        )

        workers = []

        if not results:
            return workers

        result = results[0]

        if result.boxes is None:
            return workers

        boxes = result.boxes

        for i in range(len(boxes)):

            confidence = float(
                boxes.conf[i]
            )

            bbox = boxes.xyxy[i].tolist()

            track_id = None

            if boxes.id is not None:

                track_id = int(
                    boxes.id[i]
                )

            workers.append({

                "track_id":
                    track_id,

                "confidence":
                    confidence,

                "bbox":
                    bbox
            })

        return workers