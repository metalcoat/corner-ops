from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]

stage_map = {
    "Stage 0 / security boundary": [1,2,3,12,13,14,27,28,29,32,69,88,90,94,100],
    "Cost stabilization": [26,56,76,77],
    "Stage 1 / payroll and scheduling correctness": [4,5,7,35,36,39,92],
    "Stage 2 / ledger integrity": [8,15,16,17,18,19,20,41,42,43,44,45,46,47,85],
    "Stage 3 / reliability and publish correctness": [9,10,11,21,22,23,30,31,33,37,40,48,53,55,59,67,75],
    "Stage 4 / security, audit and expense integrity": [6,25,49,50,51,52,57,58,60,61,68,70],
    "Stages 5-6 / runtime correctness, compliance and UX": [24,38,54,62,63,64,65,66,73,78,79,80,81,82,83,84,86,87,89,91,93,98,99],
    "Stage 7 / repository, CSS and dependencies": [34,97],
    "Stage 8 / migrations and runtime DDL": [71],
    "Stage 9 / final structural reconciliation": [72,74,95,96],
}

owners: dict[int, str] = {}
for stage, ids in stage_map.items():
    for finding in ids:
        if finding in owners:
            raise RuntimeError(f"CO-{finding:03d} mapped twice")
        owners[finding] = stage

expected = set(range(1, 101))
actual = set(owners)
if actual != expected:
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    raise RuntimeError(f"Reconciliation map mismatch; missing={missing}, extra={extra}")

metrics_path = ROOT / ".stage9-metrics.md"
if not metrics_path.exists():
    raise RuntimeError("Stage 9 metrics report is missing")
metrics = metrics_path.read_text()
required_metrics = [
    "Distributed hard-coded hex occurrences: 0",
    "Missing referenced tokens: 0",
    "## response_helper_defs: 1",
    "## request_failed_literals: 1",
    "## first_name_defs: 1",
    "## standalone_defs: 1",
    "## ios_defs: 1",
    "## install_prompt_types: 1",
    "## money_defs: 0",
    "## canvas_draws: 1",
    "## legacy_square_crypto: 0",
    "## module_call_feed_cache: 0",
    "## window_fetch_assignment: 0",
    "## old_publish_recovery: 0",
]
for marker in required_metrics:
    if marker not in metrics:
        raise RuntimeError(f"Final reconciliation metric failed: {marker}")

lines = [
    "# Corner Ops CODEBASEREVIEW remediation ledger",
    "",
    "This ledger reconciles the 100 stable findings from `CODEBASEREVIEW.md` against the staged remediation that was tested and deployed. The permanent CI guards in `verify.yml`, `verify_no_runtime_ddl.py`, `verify_dependencies.py`, and `verify_review_regressions.py` protect the structural end state.",
    "",
    "| Finding | Status | Remediation stage |",
    "|---|---|---|",
]
for finding in range(1, 101):
    lines.append(f"| CO-{finding:03d} | Closed | {owners[finding]} |")
lines += [
    "",
    "## Final structural checks",
    "",
    "- Runtime schema DDL in application source: **0 occurrences**.",
    "- Distributed hard-coded CSS hex values outside the central palette: **0 occurrences**.",
    "- Legacy Square credential crypto outside the shared integration crypto module: **0 occurrences**.",
    "- Module-local Deli 3CX call-feed cache: **0 occurrences**; cache is persisted through migration `0008`.",
    "- Retired schedule publish monkey patches/recovery helpers: **0 occurrences**.",
    "- All 100 stable CO IDs are represented exactly once in this ledger.",
    "",
    "SMS transport remains intentionally unconfigured until a provider is chosen. The opt-out/consent and outbound gating code is present, but ordinary employee messaging does not depend on an SMS provider.",
    "",
]
(ROOT / "CODEBASEREVIEW-REMEDIATION.md").write_text("\n".join(lines))
print("Final CODEBASEREVIEW reconciliation passed: CO-001 through CO-100 are mapped exactly once.")
