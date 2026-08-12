from pathlib import Path
p = Path('src/app/ops/workforce/page.tsx')
s = p.read_text()
s = s.replace('''type TimeOff = ScheduleTimeOff & {
  reason: string;
  employee_name: string;
  starts_on: string;
  ends_on: string;
};''', '''type TimeOff = ScheduleTimeOff & {
  reason: string;
  employee_name: string;
  starts_on: string;
  ends_on: string;
  created_at: string;
};''', 1)
old = '''return <div className="wfRequest" key={request.id}><div><strong>{request.employee_name}</strong><span>{dateOnly(request.starts_on)} through {dateOnly(request.ends_on)}</span>{request.reason && <p>{request.reason}</p>}'''
new = '''return <div className="wfRequest" key={request.id}><div><strong>{request.employee_name}</strong><span>{dateOnly(request.starts_on)} through {dateOnly(request.ends_on)}</span><small>Submitted {local(request.created_at)} via Employee Hub</small>{request.reason && <p>{request.reason}</p>}'''
if old not in s:
    raise SystemExit('time-off card block not found')
s = s.replace(old, new, 1)
p.write_text(s)
