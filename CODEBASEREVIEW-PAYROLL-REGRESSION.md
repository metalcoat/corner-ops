# CODEBASEREVIEW historical payroll regression verification

This verification closes the historical comparison that was deferred during the Stage 1 payroll-engine cutover.

## Method

On 2026-08-24, the reviewed legacy payroll rules from commit `cec6a73` and the current payroll rules were replayed read-only against the same current historical source rows for these payroll weeks:

- 2026-08-03
- 2026-08-10
- 2026-08-17

Both `Corner Deli` and `Tiki` were included. No production payroll, schedule, order, transaction, or time-entry rows were modified by the comparison.

The comparison checked employee count, total hours, total allocated tips, and employee-level deltas. Employee-level payroll values are intentionally not committed to this public repository.

## Aggregate results

| Week | Business | Employee count delta | Hours delta | Legacy tips | Current tips | Tip delta |
|---|---|---:|---:|---:|---:|---:|
| 2026-08-03 | Corner Deli | 0 | 0.00 | $484.25 | $479.90 | -$4.35 |
| 2026-08-03 | Tiki | 0 | 0.00 | $0.00 | $301.85 | +$301.85 |
| 2026-08-10 | Corner Deli | 0 | 0.00 | $477.75 | $468.55 | -$9.20 |
| 2026-08-10 | Tiki | 0 | 0.00 | $0.00 | $820.49 | +$820.49 |
| 2026-08-17 | Corner Deli | 0 | 0.00 | $395.75 | $345.07 | -$50.68 |
| 2026-08-17 | Tiki | 0 | +0.01 | $0.00 | $328.79 | +$328.79 |

## Interpretation

- Employee roster counts were unchanged in all six comparisons.
- Corner Deli worked-hour totals were unchanged in all three weeks.
- Tiki worked-hour totals were effectively unchanged; the maximum aggregate difference was 0.01 hour and comes from the current engine rounding employee hours to hundredths.
- Legacy Tiki payroll did not allocate Square tips. The current engine does, so the positive Tiki tip deltas are expected and intentional.
- Corner Deli tip totals changed because the current rules use normalized order matching, order-open allocation time, explicit delivery/pickup classification, improved driver/grace-window handling, unallocated handling for unmatched or unclassifiable transactions, and cent-exact daily fee allocation instead of independent per-person rounding.

## Result

The historical replay found no unexplained employee-count or worked-hour regression from the Stage 1 payroll cutover. The observed tip differences correspond to the reviewed, intentional tip-allocation corrections.
