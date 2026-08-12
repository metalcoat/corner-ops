from pathlib import Path

p = Path('src/app/employee/page.tsx')
s = p.read_text()

old = '''  async function action(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }
'''
new = '''  async function action(body: Record<string, unknown>, success: string): Promise<boolean> {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice(success);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }
'''
if old not in s:
    raise SystemExit('action block not found')
s = s.replace(old, new, 1)

replacements = [
('''    await action({
      action: "message-send",
      recipientEmployeeId: form.get("recipientEmployeeId") || null,
      body: form.get("body"),
    }, "Message sent.");
    formElement.reset();
''', '''    const saved = await action({
      action: "message-send",
      recipientEmployeeId: form.get("recipientEmployeeId") || null,
      body: form.get("body"),
    }, "Message sent.");
    if (saved) formElement.reset();
'''),
('''    await action({
      action: "shift-request",
      requestType: "Swap",
      shiftId: form.get("shiftId"),
      offeredShiftId: form.get("offeredShiftId"),
      note: form.get("note"),
    }, "Swap request sent to the other employee.");
    formElement.reset();
''', '''    const saved = await action({
      action: "shift-request",
      requestType: "Swap",
      shiftId: form.get("shiftId"),
      offeredShiftId: form.get("offeredShiftId"),
      note: form.get("note"),
    }, "Swap request sent to the other employee.");
    if (saved) formElement.reset();
'''),
('''    await action({
      action: "time-correction-request",
      sourceId: form.get("sourceId"),
      requestedClockIn: form.get("requestedClockIn") || null,
      requestedClockOut: form.get("requestedClockOut") || null,
      reason: form.get("reason"),
    }, "Time correction submitted for review.");
    formElement.reset();
''', '''    const saved = await action({
      action: "time-correction-request",
      sourceId: form.get("sourceId"),
      requestedClockIn: form.get("requestedClockIn") || null,
      requestedClockOut: form.get("requestedClockOut") || null,
      reason: form.get("reason"),
    }, "Time correction submitted for review.");
    if (saved) formElement.reset();
'''),
('''    await action({
      action: "availability-save",
      weekday: Number(form.get("weekday")),
      available: form.get("available") === "yes",
      availableFrom: form.get("availableFrom"),
      availableTo: form.get("availableTo"),
      notes: form.get("notes"),
    }, "Availability saved.");
    formElement.reset();
''', '''    const saved = await action({
      action: "availability-save",
      weekday: Number(form.get("weekday")),
      available: form.get("available") === "yes",
      availableFrom: form.get("availableFrom"),
      availableTo: form.get("availableTo"),
      notes: form.get("notes"),
    }, "Availability saved.");
    if (saved) formElement.reset();
'''),
('''    await action({
      action: "time-off-request",
      startsOn: form.get("startsOn"),
      endsOn: form.get("endsOn"),
      reason: form.get("reason"),
    }, "Time-off request submitted.");
    formElement.reset();
''', '''    const saved = await action({
      action: "time-off-request",
      startsOn: form.get("startsOn"),
      endsOn: form.get("endsOn"),
      reason: form.get("reason"),
    }, "Time-off request submitted.");
    if (saved) formElement.reset();
'''),
]

for old_block, new_block in replacements:
    if old_block not in s:
        raise SystemExit('form block not found')
    s = s.replace(old_block, new_block, 1)

p.write_text(s)
