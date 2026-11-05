FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30

WORKDIR /app
# requirements.lock is generated from requirements.txt with hashes (see its header).
COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
RUN addgroup --system --gid 10001 shuzhiren && adduser --system --uid 10001 --ingroup shuzhiren gateway
COPY --chown=gateway:shuzhiren app.py audio.py .

EXPOSE 8090
USER gateway
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
