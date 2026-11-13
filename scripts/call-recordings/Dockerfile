# Local transcription of store call recordings (scripts/call-recordings/README.md). CPU only.
FROM python:3.12-slim
RUN pip install --no-cache-dir faster-whisper==1.1.1 requests==2.32.3 av==12.3.0
WORKDIR /app
COPY redact.py transcribe.py ./
ENV HF_HOME=/models PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "transcribe.py"]
