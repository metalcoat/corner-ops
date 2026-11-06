#!/usr/bin/env python3
"""Plain-English list of what's using the Corner Ops server disk, largest first, for the low-disk email
(deploy/docker-cleanup.sh). Short lines so it reads on a phone. Read-only: it never deletes anything."""
import json
import os
import re
import shutil
import subprocess

UNITS = {"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12, "kB": 1e3}


def run(command):
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=120).stdout
    except Exception:
        return ""


def to_bytes(text):
    match = re.match(r"([\d.]+)\s*([kKMGT]?B)", str(text).strip())
    return float(match.group(1)) * UNITS.get(match.group(2), UNITS.get(match.group(2).upper(), 1)) if match else 0.0


def size(value):
    return f"{value / 1e9:.1f} GB" if value >= 1e8 else f"{value / 1e6:.0f} MB"


def du(path):
    output = run(["du", "-sb", path])
    return float(output.split()[0]) if output.strip() else 0.0


def main():
    rows = []  # (bytes, label, advice)
    used_images = set(run(["sh", "-c", "docker ps -aq | xargs -r docker inspect --format '{{.Image}}'"]).split())
    images = [json.loads(line) for line in run(["docker", "images", "--no-trunc", "--format", "{{json .}}"]).splitlines() if line.strip()]
    unique = {}
    for image in images:
        unique.setdefault(image["ID"], image)
    total_images = sum(to_bytes(image["Size"]) for image in unique.values())
    biggest = sorted(unique.values(), key=lambda image: -to_bytes(image["Size"]))[:4]
    names = ", ".join(
        f"{image['Repository'].split('/')[-1]}:{image['Tag']} {size(to_bytes(image['Size']))}{'' if image['ID'] in used_images else ' (no container now)'}"
        for image in biggest
    )
    rows.append((total_images, f"Docker images ({len(unique)}; shared layers counted once by Docker, so the real total is lower). Biggest: {names}. The phone image includes the card speech models (Vosk ~0.35 GB, LFM3 ~2.4 GB).",
                 "Ones with no container now may still be needed by an occasional job (supplier prices, phone/Android/door-alarm builds), so ask before removing; in use, :latest, :rollback and before-* are always kept."))
    df = {row.get("Type"): row for row in (json.loads(line) for line in run(["docker", "system", "df", "--format", "{{json .}}"]).splitlines() if line.strip())}
    cache = df.get("Build Cache", {})
    rows.append((to_bytes(cache.get("Size", "0B")), "Docker build cache (speeds up deploys).", "Safe to clear; the next deploy is just slower."))
    containers = df.get("Containers", {})
    rows.append((to_bytes(containers.get("Size", "0B")), "Docker container files.", "Keep: these are the running apps."))
    volumes = [json.loads(line) for line in run(["docker", "system", "df", "-v", "--format", "{{json .Volumes}}"]).splitlines() if line.strip()]
    volume_rows = volumes[0] if volumes and isinstance(volumes[0], list) else []
    for volume in sorted(volume_rows, key=lambda row: -to_bytes(row.get("Size", "0B")))[:4]:
        name = volume.get("Name", "")
        rows.append((to_bytes(volume.get("Size", "0B")), f"Docker volume {name}{' (database)' if 'postgres' in name or 'pgdata' in name else ''}.",
                     "Keep: live data." if int(volume.get("Links", 0) or 0) else "Not attached to any container; ask before removing."))
    for path, label, advice in [
        ("/opt/corner-ops/production/backups", "Production database backups (nightly).", "Keep the recent ones; old ones can be pruned by the backup job."),
        ("/opt/corner-ops/backups", "Other backups.", "Check before removing."),
        ("/opt/corner-ops/staging", "Staging copy of production.", "Rebuilt from backups; can be refreshed smaller."),
        ("/opt/corner-ops/deploy/logs", "Deploy and cleanup logs.", "Safe: older than a week are removed automatically."),
        ("/opt/corner-ops/app", "Dev source checkout (incl. node_modules).", "Keep."),
        ("/opt/corner-ops/runtime", "Dev runtime checkout.", "Keep."),
    ]:
        if os.path.isdir(path):
            rows.append((du(path), f"{path}: {label}", advice))
    home = os.path.expanduser("~")
    entries = [os.path.join(home, name) for name in os.listdir(home)] if os.path.isdir(home) else []
    biggest_home = sorted(((du(path), os.path.basename(path)) for path in entries), reverse=True)[:3]
    parts = ", ".join(f"{name} {size(value)}" for value, name in biggest_home if value >= 1e8)
    rows.append((du(home), f"{home} (home folder){': biggest ' + parts if parts else ''}.", "Caches (.cache, .npm, .gradle) are safe to clear; check anything else first."))
    rows.sort(key=lambda row: -row[0])
    total, used, free = shutil.disk_usage("/")
    print(f"Disk /: {size(free)} free of {size(total)} ({used / total:.0%} used).\n")
    print("What's using it, largest first:")
    for value, label, advice in rows:
        if value >= 5e7:
            print(f"\n- {size(value)}: {label}\n  {advice}")
    print("\nNothing here was deleted. The daily cleanup only removes unused leftovers; anything above needs a person.")


if __name__ == "__main__":
    main()
