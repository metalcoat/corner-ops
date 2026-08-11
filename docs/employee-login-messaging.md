# Employee Login Messaging

## Goal

Give owners/managers a fast way to put operational reminders in front of employees when they log into the POS, especially short instructions such as:

- double-check the freezer temperature
- verify pizza dough count before dinner
- do not use a specific prep item
- remind drivers about a temporary procedure
- review a new policy or menu change

Messages should be easy to create, easy to target, and auditable without turning every login into a hostage negotiation.

## Login experience

After an employee identifies themselves/PINs into the POS, active messages targeted to that employee are evaluated before the normal POS screen opens.

Example:

```text
GOOD AFTERNOON, SARAH

REMINDER
Please double-check the walk-in temperature
before starting prep.

[ GOT IT ]
```

For important messages:

```text
IMPORTANT - PLEASE CONFIRM

Before accepting any delivery order tonight,
verify the customer's phone number.

[ ] I READ THIS

[ ACKNOWLEDGE ]
```

Informational messages may be dismissible. Required messages must be acknowledged before the employee can continue.

## Message types

Suggested categories:

- reminder
- operational
- menu_change
- safety
- policy
- training
- urgent

Suggested priority:

- normal
- important
- critical

Critical should be reserved for genuinely blocking information so employees do not learn to click through everything automatically.

## Targeting

A message can target:

- all employees in a business
- one role group, such as Driver or In-House
- one position
- selected employees

Future targeting may include shift/time-of-day or station.

Examples:

```text
Audience: DRIVERS
Message: "Double-check cash orders before leaving."
```

```text
Audience: IN-HOUSE
Message: "New wing sauce is in the walk-in. Use old stock first."
```

## Timing and recurrence

Messages should support:

- starts immediately or at a scheduled time
- optional expiration
- show once per employee
- show once per shift
- show every login until acknowledged
- persistent until owner/manager closes the message

A short-lived reminder should not keep appearing three weeks later because nobody remembered to delete it.

## Acknowledgement / read receipts

For each employee/message combination record:

- first shown timestamp
- last shown timestamp
- acknowledgement timestamp
- employee ID
- optional time-entry/shift reference
- acknowledgement method

Owner/manager view should show:

```text
MESSAGE: Double-check walk-in temperature

Sarah      ACKNOWLEDGED   2:04 PM
Aaron      ACKNOWLEDGED   2:11 PM
John       NOT SEEN
Emily      NOT SEEN
```

This is operational acknowledgement, not proof that an employee actually completed the task unless the message explicitly requires a completion action.

## Optional task-style confirmation

Some messages can include an action confirmation separate from simple acknowledgement.

Example:

```text
DOUBLE-CHECK WALK-IN TEMPERATURE

[ ACKNOWLEDGE ]

After checking:
Temperature: [ 37 ] °F

[ MARK COMPLETE ]
```

That should be a separate message/task mode so routine notices remain one tap.

## Authoring

Owner/manager message creation should be very fast:

```text
NEW EMPLOYEE MESSAGE

Title: [ Double-check freezer ]
Message:
[ Make sure the freezer door is fully closing today. ]

Audience:
[ ALL ] [ DRIVERS ] [ IN-HOUSE ] [ SELECT PEOPLE ]

Priority:
[ NORMAL ] [ IMPORTANT ]

Show:
[ ONCE ]
[ ONCE PER SHIFT ]
[ UNTIL ACKNOWLEDGED ]

Expires:
[ Tonight at close ]

[ PUBLISH ]
```

## Permissions

Suggested defaults:

- Owner: create/edit/close all messages and view receipts
- Manager: create operational reminders for their business and view receipts
- Employee: read/acknowledge only

Policy/safety messages may optionally be owner-only to publish.

## Audit

Record creation, edits, publication, acknowledgement, completion, and closure. Do not silently rewrite a message after employees have acknowledged it. Material edits should create a new revision or reset acknowledgement state.

## Design principle

The feature should make it easier to communicate a 10-second operational reminder than to send a group text and later wonder whether anyone read it. Keep normal messages lightweight, reserve blocking acknowledgement for things that actually matter.
