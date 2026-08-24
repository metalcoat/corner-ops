from pathlib import Path
import re
from collections import Counter, defaultdict

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
# Residual metrics are intentionally mechanical; Stage 9 fixes only what still exists on current main.

code_files = [p for p in SRC.rglob("*") if p.suffix in {".ts", ".tsx", ".js", ".mjs"}]
css_files = list(SRC.rglob("*.css"))
palette_file = SRC / "app/color-tokens.css"


def count_code(pattern: str, exclude: set[str] | None = None):
    rx = re.compile(pattern, re.M)
    rows = []
    exclude = exclude or set()
    for p in code_files:
        rel = p.relative_to(ROOT).as_posix()
        if rel in exclude:
            continue
        text = p.read_text(errors="replace")
        matches = list(rx.finditer(text))
        if matches:
            rows.append((rel, len(matches)))
    return rows

metrics = {
    "response_helper_defs": count_code(r"\b(?:async\s+)?function\s+(?:responseMessage|responseError|responseErrorMessage|errorMessage)\s*\("),
    "request_failed_literals": count_code(r"Request failed\s*\("),
    "first_name_defs": count_code(r"\bfunction\s+firstName\s*\("),
    "standalone_defs": count_code(r"\bfunction\s+isStandalone\s*\("),
    "ios_defs": count_code(r"\bfunction\s+isIos\s*\("),
    "install_prompt_types": count_code(r"\b(?:type|interface)\s+(?:InstallPromptEvent|BeforeInstallPromptEvent)\b"),
    "money_defs": count_code(r"\bfunction\s+money\s*\("),
    "canvas_draws": count_code(r"\.drawImage\s*\("),
    "legacy_square_crypto": count_code(r"corner-ops-integrations:|SESSION_SECRET is required before Square can store credentials", {"src/lib/integration-crypto.ts"}),
    "module_call_feed_cache": count_code(r"\bcallFeedCache\b|\bcallFeedPromise\b"),
    "window_fetch_assignment": count_code(r"window\.fetch\s*="),
    "old_publish_recovery": count_code(r"sendRecoveredPublishNotifications|SchedulePublishConfirmFix|overnight-shift-helper"),
}

hex_rx = re.compile(r"#[0-9a-fA-F]{3,8}\b")
token_ref_rx = re.compile(r"var\(--([A-Za-z0-9_-]+)\)")
token_def_rx = re.compile(r"--([A-Za-z0-9_-]+)\s*:")
important = 0
hexes = Counter()
token_refs = Counter()
token_defs = Counter()
selector_files = defaultdict(set)
css_bytes = sum(len(p.read_bytes()) for p in css_files)
for p in css_files:
    rel = p.relative_to(ROOT).as_posix()
    text = p.read_text(errors="replace")
    important += text.count("!important")
    if p != palette_file:
        hexes.update(x.lower() for x in hex_rx.findall(text))
    token_refs.update(token_ref_rx.findall(text))
    token_defs.update(token_def_rx.findall(text))
    if p == palette_file:
        continue
    for m in re.finditer(r"(?:^|\})([^{}]+)\{", text, re.M):
        chunk = m.group(1).strip()
        if not chunk or chunk.startswith("@") or re.fullmatch(r"(?:from|to|\d+%)", chunk):
            continue
        for selector in chunk.split(","):
            s = re.sub(r"\s+", " ", selector.strip())
            if s:
                selector_files[s].add(rel)

dup_selectors = [(s, sorted(files)) for s, files in selector_files.items() if len(files) > 1]
missing_tokens = sorted(set(token_refs) - set(token_defs))
patch_css = sorted(p.relative_to(ROOT).as_posix() for p in css_files if "fix" in p.name.lower() or "cleanup" in p.name.lower())

out = [
    "# Stage 9 residual metrics",
    "",
    f"Code files: {len(code_files)}",
    f"CSS files: {len(css_files)}",
    f"CSS bytes: {css_bytes}",
    f"CSS !important: {important}",
    f"Distributed hard-coded hex occurrences: {sum(hexes.values())}",
    f"Unique distributed hard-coded hex values: {len(hexes)}",
    f"Token references: {sum(token_refs.values())}",
    f"Token definitions: {sum(token_defs.values())}",
    f"Missing referenced tokens: {len(missing_tokens)}",
    f"Selectors declared in multiple stylesheets: {len(dup_selectors)}",
    "",
]
for name, rows in metrics.items():
    out.append(f"## {name}: {sum(n for _, n in rows)}")
    for path, n in rows:
        out.append(f"- `{path}` ×{n}")
    out.append("")

out += ["## Missing CSS tokens"]
out += [f"- `--{name}`" for name in missing_tokens] or ["- none"]
out += ["", "## Patch-named CSS files"]
out += [f"- `{name}`" for name in patch_css] or ["- none"]
out += ["", "## Top distributed hard-coded colours"]
for value, n in hexes.most_common(40):
    out.append(f"- `{value}` ×{n}")
out += ["", "## Duplicate selectors (first 100)"]
for selector, files in sorted(dup_selectors, key=lambda item: (-len(item[1]), item[0]))[:100]:
    out.append(f"- `{selector}` — {', '.join(f'`{f}`' for f in files)}")
out.append("")

(ROOT / ".stage9-metrics.md").write_text("\n".join(out))
print("\n".join(out[:40]))
