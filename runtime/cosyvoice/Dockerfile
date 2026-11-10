FROM nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04@sha256:622e78a1d02c0f90ed900e3985d6c975d8e2dc9ee5e61643aed587dcf9129f42

ARG MINIFORGE_URL
ARG MINIFORGE_SHA256
ARG RELEASE_REVISION

LABEL org.opencontainers.image.revision=$RELEASE_REVISION

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PATH=/opt/conda/envs/cosyvoice/bin:/opt/conda/bin:$PATH
ENV PYTHONPATH=/opt/CosyVoice/CosyVoice:/opt/CosyVoice/CosyVoice/third_party/Matcha-TTS

RUN test -n "$MINIFORGE_URL" && test -n "$MINIFORGE_SHA256" && \
    case "$MINIFORGE_URL" in https://*) ;; *) exit 1 ;; esac && \
    echo "$MINIFORGE_SHA256" | grep -Eq '^[a-f0-9]{64}$'
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl build-essential patch ffmpeg libsndfile1 sox libsox-dev && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10003 cosyvoice && useradd --system --uid 10003 --gid 10003 --home-dir /tmp --no-create-home cosyvoice
RUN curl --fail --location --retry 3 "$MINIFORGE_URL" --output /tmp/miniforge.sh && \
    echo "$MINIFORGE_SHA256  /tmp/miniforge.sh" | sha256sum -c - && \
    bash /tmp/miniforge.sh -b -p /opt/conda && \
    rm /tmp/miniforge.sh
COPY --chown=cosyvoice:cosyvoice vendor/CosyVoice /opt/CosyVoice/CosyVoice
COPY runtime/patches/cosyvoice-*.patch /tmp/cosyvoice-patches/
# The upstream FastAPI sample server decodes the uploaded prompt into a tensor
# and then passes that tensor back to frontend.load_wav(), which expects a path
# or file-like object. Keep the upload stream intact and let the model frontend
# perform the one decode/resample itself.
RUN patch -p1 -d /opt/CosyVoice/CosyVoice < /tmp/cosyvoice-patches/cosyvoice-fastapi-file-input.patch && rm -rf /tmp/cosyvoice-patches
# Source-only requirements such as openai-whisper==20231117 import pkg_resources
# from setup.py. pip builds them in isolated environments that fetch the newest
# setuptools, and setuptools 82.0.0 removed pkg_resources (81.x is the last major
# that ships it). Build-time and runtime setuptools are held below 81 to stay on
# the 80.x line.
# pip 26.2+ no longer applies PIP_CONSTRAINT to isolated build environments, so
# the file is passed with --build-constraint (pip >= 25.3), which affects only
# build dependencies and leaves the installed runtime packages unconstrained.
RUN conda config --system --add channels conda-forge && \
    conda config --system --set channel_priority strict && \
    conda create -y -n cosyvoice python=3.10 && \
    conda install -y -n cosyvoice -c conda-forge pynini==2.1.5 && \
    printf 'setuptools<81\n' > /tmp/pip-build-constraints.txt && \
    /opt/conda/envs/cosyvoice/bin/pip install --no-cache-dir --build-constraint /tmp/pip-build-constraints.txt -r /opt/CosyVoice/CosyVoice/requirements.txt && \
    /opt/conda/envs/cosyvoice/bin/pip install --no-cache-dir 'setuptools<81' && \
    rm /tmp/pip-build-constraints.txt && \
    chown -R cosyvoice:cosyvoice /opt/CosyVoice

WORKDIR /opt/CosyVoice/CosyVoice
EXPOSE 50000
USER cosyvoice
