FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/tmp
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg libgl1 libglib2.0-0 git && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10002 livetalking && useradd --system --uid 10002 --gid 10002 --home-dir /tmp --no-create-home livetalking
COPY vendor/LiveTalking/requirements.txt ./requirements.txt
RUN python3 -m pip install --break-system-packages --no-cache-dir torch==2.9.1 torchvision==0.24.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cu128 && python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt
COPY vendor/LiveTalking/ ./
COPY runtime/patches/livetalking-observability.patch /tmp/livetalking-observability.patch
# models/ and data/ are excluded from the build context; keep them as the
# Runtime Compose mount points.
RUN git apply --check --recount /tmp/livetalking-observability.patch && git apply --recount /tmp/livetalking-observability.patch && mkdir -p /app/models /app/data/avatars /app/data/record && chown -R livetalking:livetalking /app

EXPOSE 8010
USER livetalking
CMD ["python3", "app.py"]
