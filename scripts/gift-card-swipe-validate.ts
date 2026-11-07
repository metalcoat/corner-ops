#!/usr/bin/env node
import assert from "node:assert/strict";
import { giftCardNumberFromInput, validGiftCardInput } from "../src/lib/gift-card-input";

const printed = "1234567890123456";
assert.equal(giftCardNumberFromInput(printed), printed);
assert.equal(giftCardNumberFromInput(`%B${printed}^CORNER/DELI^99121010000000000000?`), printed);
assert.equal(giftCardNumberFromInput(`;${printed}=99121010000000000000?`), printed);
assert.equal(giftCardNumberFromInput("GC-1234-5678"), "GC12345678");
assert.equal(validGiftCardInput("1234"), false);
assert.equal(validGiftCardInput(`;${printed}=9912?`), true);
console.log(JSON.stringify({ printedNumber: true, track1: true, track2: true, keyboardWedge: true }, null, 2));
