# Store call recordings: local transcription (2026-11-08)

Deli calls (3CX extensions 95 and 96) are pulled from the 3CX box (192.168.1.46) over the store network with a
read-only key (`~/.ssh/3cx_recordings`, limited on the 3CX side to `rrsync -ro .../Data/Recordings`) into
`/opt/corner-ops/private/call-recordings` (mode 700, owner chris; outside the app, web paths and the off-site
backup). Other extensions are never pulled.

Rules: audio never leaves the server and is never sent to Gemini, Claude or any outside service. Every transcript
line goes through `redact.py` before it is written: any run of 3+ digits (card numbers, expirations, security
codes, ZIPs, phone numbers, street numbers), in numerals or words, becomes `[NUMBER]`. Output file names drop the
caller's number. Audio is deleted once the work is done.

    docker build -t corner-ops-transcribe:local scripts/call-recordings      # faster-whisper large-v3-turbo, CPU
    # one-time model download (network, no audio): see transcribe.py / Dockerfile, HF_HOME=/models
    docker run -d --name corner-ops-transcribe --network none --cpus 4 --cpu-shares 128 --memory 6g \
      --user $(id -u):$(id -g) -e HOME=/tmp -e HF_HUB_OFFLINE=1 \
      -v /opt/corner-ops/private/call-recordings/models:/models \
      -v /opt/corner-ops/private/call-recordings/audio:/audio:ro \
      -v /opt/corner-ops/private/call-recordings/transcripts:/transcripts corner-ops-transcribe:local

It skips calls already transcribed, so it can be stopped and started. Redaction test: `python3 scripts/call-recordings/redact-test.py`.
