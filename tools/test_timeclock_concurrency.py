"""Real concurrent connections against the disposable CI PostgreSQL database."""
import json
import os
import subprocess
import uuid

if os.environ.get("PGDATABASE") != "corner_ops_test":
    raise SystemExit("This test is restricted to the disposable corner_ops_test database.")
employee = str(uuid.uuid4())
def query(sql):
    result = subprocess.run(["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], text=True, capture_output=True, check=True)
    return result.stdout.strip()
def command(key, action, entry=None):
    target = f"'{entry}'::uuid" if entry else "NULL::uuid"
    return f"SELECT public.corner_ops_punch_tiki('{employee}', '{key}', '{action}', {target}, NULL, NULL, NULL, '');"
def together(commands):
    processes = [subprocess.Popen(["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", "BEGIN; SET LOCAL statement_timeout='10s'; " + sql + " SELECT pg_sleep(0.3); COMMIT;"], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for sql in commands]
    results = []
    for process in processes:
        output, error = process.communicate(timeout=15)
        assert process.returncode == 0, error
        results.append(json.loads(next(line for line in output.splitlines() if line.startswith("{"))))
    return results
try:
    query(f"INSERT INTO public.employees(id,business,name,pin_hash) VALUES ('{employee}','Tiki','Concurrency Test','synthetic');")
    key = str(uuid.uuid4())
    results = together([command(key, "clock-in"), command(key, "clock-in")])
    entry = results[0]["entry"]["id"]
    assert results[1]["entry"]["id"] == entry
    assert sorted(result["replayed"] for result in results) == [False, True]
    assert query(f"SELECT count(*) FROM time_entries WHERE employee_id='{employee}'") == "1"
    results = together([command(str(uuid.uuid4()), "clock-out", entry), command(str(uuid.uuid4()), "clock-out", entry)])
    assert all(result["action"] == "clocked-out" for result in results)
    assert query(f"SELECT count(*) FROM time_entries WHERE employee_id='{employee}' AND clock_out IS NULL") == "0"
    results = together([command(str(uuid.uuid4()), "clock-in", entry), command(str(uuid.uuid4()), "clock-in", entry)])
    assert sum(result.get("action") == "clocked-in" for result in results) == 1
    assert sum(result.get("code") == "PUNCH_STATE_CHANGED" for result in results) == 1
    assert query(f"SELECT count(*) FROM time_entries WHERE employee_id='{employee}' AND clock_out IS NULL") == "1"
    print("Concurrent same-key replay, duplicate clock-out, and competing clock-in tests passed.")
finally:
    query(f"DELETE FROM timeclock_punch_requests WHERE employee_id='{employee}'; DELETE FROM time_entries WHERE employee_id='{employee}'; DELETE FROM employees WHERE id='{employee}';")
