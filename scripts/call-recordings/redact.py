"""Redaction for store call transcripts (2026-11-08). Runs on every transcript line BEFORE it is written anywhere.

Card numbers, expirations, security codes, ZIPs, phone numbers and street numbers are all runs of digits, so any
run of 3 or more digits is replaced, whether Whisper wrote them as numerals ("4152 3333") or words ("four one five
two", "forty one fifty two"). Quantities and sizes ("30 wings", "two liter", "16 inch") have at most 2 digits and
survive. A card number never survives in any form; an address or phone number losing its digits is intended.
"""
import re

UNITS = {"zero": 0, "oh": 0, "o": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9}
TEENS = {"ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fourty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
SCALE = {"hundred", "thousand", "double", "triple"}
NUMBER_WORD = set(UNITS) | set(TEENS) | set(TENS) | SCALE
TOKEN = re.compile(r"[A-Za-z]+|\d+|[^\sA-Za-z\d]+|\s+")
JOINERS = {"-", ",", ".", "/", "and", "dash"}

def _digits(token):
    """How many digits this token says, or None if it isn't part of a number."""
    low = token.lower()
    if token.isdigit():
        return len(token)
    if low in UNITS and low not in ("o", "oh"):
        return 1
    if low in ("o", "oh"):
        return 1  # counted only next to other digits (see redact)
    if low in TEENS or low in TENS:
        return 2
    if low in SCALE:
        return 1  # "double five", "four hundred": still a longer number
    return None

def redact(text, label="[NUMBER]"):
    tokens = TOKEN.findall(str(text or ""))
    out, run, digits, real = [], [], 0, 0

    def flush():
        nonlocal run, digits, real
        if run:
            # Drop joiners/spaces trailing the run back into the output untouched.
            tail = []
            while run and (run[-1].isspace() or run[-1].lower() in JOINERS):
                tail.insert(0, run.pop())
            if digits >= 3 and real:
                out.append(label)
            else:
                out.extend(run)
            out.extend(tail)
        run, digits, real = [], 0, 0

    def next_is_number(index):
        for later in tokens[index + 1:]:
            if later.isspace():
                continue
            return _digits(later) is not None and later.lower() not in ("o", "oh")
        return False

    for index, token in enumerate(tokens):
        count = _digits(token)
        if count is not None and not (token.lower() in ("o", "oh") and not real and not next_is_number(index)):
            run.append(token)
            digits += count
            real += token.lower() not in SCALE
            continue
        if run and (token.isspace() or token.lower() in JOINERS):
            run.append(token)
            continue
        flush()
        out.append(token)
    flush()
    return "".join(out)
