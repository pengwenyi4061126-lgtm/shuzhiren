FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/tmp
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg libgl1 libglib2.0-0 git && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10002 livetalking && useradd --system --uid 10002 --gid 10002 --home-dir /tmp --no-create-home livetalking
COPY vendor/LiveTalking/requirements.txt ./requirements.txt
RUN python3 -m pip install --break-system-packages --no-cache-dir torch==2.9.1 torchvision==0.24.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cu128 && python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt
COPY vendor/LiveTalking/ ./
COPY runtime/patches/livetalking.series runtime/patches/livetalking-*.patch /tmp/livetalking-patches/
# Apply runtime/patches/livetalking.series in order; any failing patch fails the
# build. models/ and data/ are excluded from the build context; keep them as the
# Runtime Compose mount points.
RUN set -eu; cr="$(printf '\r')"; \
    while IFS= read -r patch; do patch="${patch%"$cr"}"; case "$patch" in ''|'#'*) continue;; esac; \
      git apply --check --recount "/tmp/livetalking-patches/$patch"; git apply --recount "/tmp/livetalking-patches/$patch"; \
    done < /tmp/livetalking-patches/livetalking.series; \
    rm -rf /tmp/livetalking-patches; \
    mkdir -p /app/models /app/data/avatars /app/data/record; \
    chown -R livetalking:livetalking /app
# The launcher (PID 1) validates the stream key file and redacts LiveTalking's
# stdout/stderr; the patched sources import shuzhiren_secrets from here.
COPY runtime/livetalking/launcher.py runtime/livetalking/shuzhiren_secrets.py /opt/shuzhiren/
ENV PYTHONPATH=/opt/shuzhiren

EXPOSE 8010
USER livetalking
ENTRYPOINT ["python3", "/opt/shuzhiren/launcher.py"]
CMD ["python3", "app.py"]
