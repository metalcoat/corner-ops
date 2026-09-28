import assert from "node:assert/strict";
import test from "node:test";
import { employeePinLabel, employeePinLength, employeePinPattern, validateEmployeePin } from "../src/lib/employee-pin";

test("Corner Deli issues four-digit employee PINs", () => {
  assert.equal(employeePinLength("Corner Deli"), 4);
  assert.equal(employeePinLabel("Corner Deli"), "Four-digit PIN");
  assert.equal(employeePinPattern("Corner Deli"), "\\d{4}");
  assert.equal(validateEmployeePin("Corner Deli", "1234"), "1234");
});

test("legacy five-digit Corner Deli PINs remain valid during transition", () => {
  assert.equal(validateEmployeePin("Corner Deli", "12345"), "12345");
  assert.throws(() => validateEmployeePin("Corner Deli", "123"), /4 digits/);
});

test("Tiki continues using five-digit PINs", () => {
  assert.equal(employeePinLength("Tiki"), 5);
  assert.equal(employeePinPattern("Tiki"), "\\d{5}");
  assert.equal(validateEmployeePin("Tiki", "12345"), "12345");
  assert.throws(() => validateEmployeePin("Tiki", "1234"), /exactly 5 digits/);
});
