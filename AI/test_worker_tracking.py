import cv2
from AI.worker_tracking import WorkerTracker


tracker = WorkerTracker()

video_path = video_path = r"D:\AwareX\vidoes\14990643_2160_3840_30fps.mp4"

cap = cv2.VideoCapture(video_path)

if not cap.isOpened():
    raise RuntimeError("Could not open video")

all_ids = set()
frames = 0

while True:
    ret, frame = cap.read()

    if not ret:
        break

    frames += 1

    if frames % 10 != 0:
        continue

    workers = tracker.track_frame(frame)

    for worker in workers:
        if worker["track_id"] is not None:
            all_ids.add(worker["track_id"])

    print(
        f"Frame {frames}: "
        f"workers={len(workers)}, "
        f"IDs={all_ids}"
    )

cap.release()

print("\n==============================")
print("UNIQUE WORKERS:", len(all_ids))
print("==============================")