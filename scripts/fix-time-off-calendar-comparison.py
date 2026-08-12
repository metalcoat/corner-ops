from pathlib import Path

p = Path('src/lib/schedule-time-off.ts')
s = p.read_text()
s = s.replace(
'''      AND (t.starts_on::date AT TIME ZONE ${TIME_ZONE}) < ${end.toISOString()}
      AND ((t.ends_on::date + 1) AT TIME ZONE ${TIME_ZONE}) > ${start.toISOString()}''',
'''      AND t.starts_on <= ((${end.toISOString()}::timestamptz - INTERVAL '1 millisecond') AT TIME ZONE ${TIME_ZONE})::date
      AND t.ends_on >= (${start.toISOString()}::timestamptz AT TIME ZONE ${TIME_ZONE})::date''',
1,
)
p.write_text(s)

p = Path('src/lib/workforce.ts')
s = p.read_text()
s = s.replace(
'''      AND starts_at < ((${request.ends_on}::date + 1) AT TIME ZONE ${TIME_ZONE})
      AND ends_at > (${request.starts_on}::date AT TIME ZONE ${TIME_ZONE})''',
'''      AND (starts_at AT TIME ZONE ${TIME_ZONE})::date <= ${request.ends_on}::date
      AND ((ends_at - INTERVAL '1 millisecond') AT TIME ZONE ${TIME_ZONE})::date >= ${request.starts_on}::date''',
1,
)
p.write_text(s)

p = Path('src/lib/schedule-publish-validation.ts')
s = p.read_text()
s = s.replace(
'''      AND (t.starts_on::date AT TIME ZONE ${TIME_ZONE}) < s.ends_at
      AND ((t.ends_on::date + 1) AT TIME ZONE ${TIME_ZONE}) > s.starts_at''',
'''      AND t.starts_on <= ((s.ends_at - INTERVAL '1 millisecond') AT TIME ZONE ${TIME_ZONE})::date
      AND t.ends_on >= (s.starts_at AT TIME ZONE ${TIME_ZONE})::date''',
1,
)
p.write_text(s)

p = Path('src/lib/schedule-week-copy.ts')
s = p.read_text()
s = s.replace(
'''              AND (t.starts_on::date AT TIME ZONE ${TIME_ZONE}) < source_shifts.target_ends_at
              AND ((t.ends_on::date + 1) AT TIME ZONE ${TIME_ZONE}) > source_shifts.target_starts_at''',
'''              AND t.starts_on <= ((source_shifts.target_ends_at - INTERVAL '1 millisecond') AT TIME ZONE ${TIME_ZONE})::date
              AND t.ends_on >= (source_shifts.target_starts_at AT TIME ZONE ${TIME_ZONE})::date''',
1,
)
p.write_text(s)
