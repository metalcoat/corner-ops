"""Transcribe store call recordings locally (2026-11-08). Runs in a container with no network (see README):
audio is mounted read-only, every line is redacted (redact.py) before it is written, and nothing is sent anywhere.

Output: one JSON per call in TRANSCRIPTS/<ext>/<YYYYMMDD-HHMMSS>-<id>.json with the redacted text and segment
times. The caller's phone number in the 3CX file name is not kept.
"""
import json, os, pathlib, re, sys, time

from faster_whisper import WhisperModel
from redact import redact

AUDIO = pathlib.Path(os.environ.get("AUDIO", "/audio"))
OUT = pathlib.Path(os.environ.get("TRANSCRIPTS", "/transcripts"))
MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
THREADS = int(os.environ.get("WHISPER_THREADS", "4"))
LIMIT = int(os.environ.get("LIMIT", "0"))
# Words the store uses, so the model spells them right.
PROMPT = "Corner Deli phone order. Pizza, jumbo, pepperoni, wings, mild, medium, garlic parm, blue cheese, celery, Big Boss, poutine, hamburger steak, gravy, mashed, fries, Nacho Supreme, delivery, pickup."
NAME = re.compile(r"_(\d{14})\((\d+)\)\.wav$")


def main():
    model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
    files = sorted(AUDIO.rglob("*.wav"))
    done = 0
    started = time.time()
    audio_seconds = 0.0
    for path in files:
        match = NAME.search(path.name)
        if not match:
            continue
        ext = path.parent.name
        when, rec_id = match.groups()
        target = OUT / ext / f"{when[:8]}-{when[8:]}-{rec_id}.json"
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        segments, info = model.transcribe(str(path), language="en", beam_size=1, vad_filter=True, initial_prompt=PROMPT, condition_on_previous_text=False)
        rows = [{"start": round(seg.start, 1), "end": round(seg.end, 1), "text": redact(seg.text.strip())} for seg in segments]
        record = {"ext": ext, "recordedAt": f"{when[:4]}-{when[4:6]}-{when[6:8]}T{when[8:10]}:{when[10:12]}:{when[12:14]}", "recordingId": rec_id, "seconds": round(info.duration, 1), "model": MODEL, "text": " ".join(row["text"] for row in rows), "segments": rows}
        temp = target.with_suffix(".tmp")
        temp.write_text(json.dumps(record, ensure_ascii=False))
        os.chmod(temp, 0o600)
        temp.rename(target)
        done += 1
        audio_seconds += info.duration
        if done % 10 == 0 or done == 1:
            elapsed = time.time() - started
            print(json.dumps({"done": done, "audioMinutes": round(audio_seconds / 60, 1), "elapsedMinutes": round(elapsed / 60, 1), "speed": round(audio_seconds / max(elapsed, 1), 2)}), flush=True)
        if LIMIT and done >= LIMIT:
            break
    print(json.dumps({"status": "finished", "done": done, "audioMinutes": round(audio_seconds / 60, 1), "elapsedMinutes": round((time.time() - started) / 60, 1)}), flush=True)


if __name__ == "__main__":
    sys.exit(main())
