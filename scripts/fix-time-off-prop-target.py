from pathlib import Path

p = Path('src/app/ops/workforce/page.tsx')
s = p.read_text()
s = s.replace(
'''      <WeekCopyPanel
        key={`copy-${business}`}
        business={business}
        shifts={currentData?.shifts || []}
        timeOff={currentData?.timeOff || []}
        busy={busy}''',
'''      <WeekCopyPanel
        key={`copy-${business}`}
        business={business}
        shifts={currentData?.shifts || []}
        busy={busy}''',
1,
)
s = s.replace(
'''      <ScheduleBoard
        key={`schedule-${business}`}
        business={business}
        employees={activeEmployees}
        shifts={currentData?.shifts || []}
        busy={busy}''',
'''      <ScheduleBoard
        key={`schedule-${business}`}
        business={business}
        employees={activeEmployees}
        shifts={currentData?.shifts || []}
        timeOff={currentData?.timeOff || []}
        busy={busy}''',
1,
)
p.write_text(s)
