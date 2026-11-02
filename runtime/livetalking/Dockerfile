FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg libgl1 libglib2.0-0 git && rm -rf /var/lib/apt/lists/*
COPY vendor/LiveTalking/requirements.txt ./requirements.txt
RUN python3 -m pip install --break-system-packages --no-cache-dir torch==2.9.1 torchvision==0.24.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cu128 && python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt
COPY vendor/LiveTalking/ ./
COPY runtime/patches/livetalking-observability.patch /tmp/livetalking-observability.patch
RUN git apply --check --recount /tmp/livetalking-observability.patch && git apply --recount /tmp/livetalking-observability.patch

EXPOSE 8010
CMD ["python3", "app.py"]
