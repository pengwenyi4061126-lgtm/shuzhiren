FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN addgroup --system --gid 10001 shuzhiren && adduser --system --uid 10001 --ingroup shuzhiren gateway
COPY --chown=gateway:shuzhiren app.py audio.py .

EXPOSE 8090
USER gateway
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
