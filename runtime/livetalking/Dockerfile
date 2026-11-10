FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04@sha256:24c8e3581ea6330038b0d374920721983312627f8adbfcf390bdb4b399d280ed

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/tmp
WORKDIR /app

# fonts-noto-cjk (SIL Open Font License 1.1, THIRD_PARTY_NOTICES.md section 7) supplies the CJK glyphs of the
# AIGC explicit label; shuzhiren_aigc_label.py reads /usr/share/fonts/opentype/noto/NotoSansCJK-*.ttc.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-psycopg2 ffmpeg libgl1 libglib2.0-0 git fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10002 livetalking && useradd --system --uid 10002 --gid 10002 --home-dir /tmp --no-create-home livetalking
COPY vendor/LiveTalking/requirements.txt ./requirements.txt
RUN python3 -m pip install --break-system-packages --no-cache-dir torch==2.9.1 torchvision==0.24.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cu128 && python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt
# MuseTalk's avatar preprocessor imports face_recognition.  dlib-bin supplies
# the CPython 3.12 wheel; installing face-recognition without dependency
# resolution avoids rebuilding dlib from source on Ubuntu 24.04.
RUN python3 -m pip install --break-system-packages --no-cache-dir dlib-bin==20.0.1.post1 face-recognition-models==0.3.0 && \
    python3 -m pip install --break-system-packages --no-cache-dir --no-deps face-recognition==1.3.0
COPY vendor/LiveTalking/ ./
# Avatar Builder runs on an internal network, so prefetch LiveTalking's SFD
# detector into the torch hub cache instead of relying on runtime egress.
RUN python3 -c 'import hashlib,pathlib,urllib.request; u="https://www.adrianbulat.com/downloads/python-fan/s3fd-619a316812.pth"; p=pathlib.Path("/tmp/.cache/torch/hub/checkpoints/s3fd-619a316812.pth"); p.parent.mkdir(parents=True,exist_ok=True); d=urllib.request.urlopen(u,timeout=120).read(); assert hashlib.sha256(d).hexdigest()=="619a31681264d3f7f7fc7a16a42cbbe8b23f31a256f75a366e5a1bcd59b33543"; p.write_bytes(d)'
COPY runtime/patches/livetalking.series runtime/patches/livetalking-*.patch /tmp/livetalking-patches/
# Apply runtime/patches/livetalking.series in order; any failing patch fails the
# build. models/ and data/ are excluded from the build context; keep them as the
# Runtime Compose mount points.
RUN set -eu; cr="$(printf '\r')"; \
    while IFS= read -r patch; do patch="${patch%"$cr"}"; case "$patch" in ''|'#'*) continue;; esac; \
      git apply --check --recount "/tmp/livetalking-patches/$patch"; git apply --recount "/tmp/livetalking-patches/$patch"; \
    done < /tmp/livetalking-patches/livetalking.series; \
    rm -rf /tmp/livetalking-patches; \
    mkdir -p /app/models /app/data/avatars /app/data/record
# Apache-2.0 4(b): ship the modification notice next to /app/LICENSE (Requirement 39.12).
COPY runtime/patches/LIVETALKING_MODIFICATIONS.md /app/LIVETALKING_MODIFICATIONS.md
RUN chown -R livetalking:livetalking /app
# The launcher (PID 1) validates the stream key file and the AIGC label and redacts
# LiveTalking's stdout/stderr; the patched sources import shuzhiren_secrets and
# shuzhiren_aigc_label from here.
COPY runtime/livetalking/launcher.py runtime/livetalking/shuzhiren_secrets.py /opt/shuzhiren/
COPY runtime/livetalking/shuzhiren_aigc_label.py /opt/shuzhiren/
# Picture layer (captions, product card, background); the patched sources import shuzhiren_overlay from here.
# Background assets are mounted read-only at /opt/shuzhiren/overlay-assets (Runtime Compose volume overlay-assets).
COPY runtime/livetalking/shuzhiren_overlay.py /opt/shuzhiren/
COPY runtime/livetalking/avatar_builder_api.py runtime/livetalking/avatar_publisher_api.py /opt/shuzhiren/
# The avatar-builder profile executes /opt/shuzhiren/avatar_builder_api.py by
# absolute path. Keep the LiveTalking application tree importable for that
# entrypoint as well as for the normal /app/app.py launcher.
ENV PYTHONPATH=/opt/shuzhiren:/app

EXPOSE 8010
USER livetalking
ENTRYPOINT ["python3", "/opt/shuzhiren/launcher.py"]
CMD ["python3", "app.py"]
