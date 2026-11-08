"""Run: python3 scripts/call-recordings/redact-test.py"""
import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("redact", pathlib.Path(__file__).with_name("redact.py"))
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
cases = {
    "my card is 4152 3333 1234 5678": "my card is [NUMBER]",
    "four one five two, three three three three": "[NUMBER]",
    "forty one fifty two thirty three": "[NUMBER]",
    "expires oh four twenty seven": "expires [NUMBER]",
    "the code is 7 3 1": "the code is [NUMBER]",
    "it's 412 Jay Street": "it's [NUMBER] Jay Street",
    "call me back at 315-555-0142": "call me back at [NUMBER]",
    "can I get 30 wings and a two liter Pepsi": "can I get 30 wings and a two liter Pepsi",
    "a 16 inch pizza and 10 mild": "a 16 inch pizza and 10 mild",
    "one large pepperoni, oh and a coke": "one large pepperoni, oh and a coke",
    "double five six eight": "[NUMBER]",
    "zip code one three six six nine": "zip code [NUMBER]",
}
bad = [(text, r.redact(text), want) for text, want in cases.items() if r.redact(text) != want]
for text, got, want in bad:
    print(f"FAIL {text!r} -> {got!r} (want {want!r})")
assert not bad, f"{len(bad)} redaction cases failed"
for text, want in cases.items():
    assert not __import__("re").search(r"\d{3}", r.redact(text)), text
print(f'{{"status": "passed", "checks": {len(cases)}}}')
