#!/usr/bin/env python3
"""Isolated card-payment EAGI: the caller can say the card details or key them in.

Audio stays inside this container (local recognizer, never Gemini); what was heard is never
logged or stored. Every step listens for speech and keypad at once.
"""
import audioop
import datetime
import fcntl
import json
import os
import re
import select
import sys
import termios
import threading
import time
import urllib.error
import urllib.request
from array import array

API=os.environ.get("VOICE_PAYMENT_API_URL","http://127.0.0.1:3000/api/internal/voice-payment")
SECRET=os.environ.get("VOICE_PAYMENT_INTERNAL_SECRET","")
VOSK_MODEL=os.environ.get("VOICE_PAYMENT_VOSK_MODEL","/opt/vosk-model")
RATE=16000  # EAGI_AUDIO_FORMAT=slin16
ALTERNATIVES=3

# ---------------------------------------------------------------- spoken number parsing

DIGIT_WORDS={"zero":"0","oh":"0","o":"0","owe":"0","nought":"0","one":"1","won":"1","two":"2","to":"2","too":"2",
  "three":"3","four":"4","for":"4","fore":"4","five":"5","six":"6","seven":"7","eight":"8","ate":"8","nine":"9"}
TEEN_WORDS={"ten":"10","eleven":"11","twelve":"12","thirteen":"13","fourteen":"14","fifteen":"15","sixteen":"16",
  "seventeen":"17","eighteen":"18","nineteen":"19"}
TENS_WORDS={"twenty":"2","thirty":"3","forty":"4","fourty":"4","fifty":"5","sixty":"6","seventy":"7","eighty":"8","ninety":"9"}
REPEAT_WORDS={"double":2,"triple":3}
MONTHS={"january":1,"jan":1,"february":2,"feb":2,"march":3,"april":4,"may":5,"june":6,"july":7,"august":8,"aug":8,
  "september":9,"sept":9,"october":10,"november":11,"december":12}
YES_WORDS={"yes","yeah","yep","yup","correct","right","sure","affirmative","ok","okay"}
NO_WORDS={"no","nope","wrong","incorrect","nah"}
# Words given to the recognizer: real dictionary words only (homophones like "for"/"to" are parsing aliases).
SPOKEN_NUMBERS=["zero","oh","one","two","three","four","five","six","seven","eight","nine",*TEEN_WORDS,
  "twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety","double","triple","hundred"]
SPOKEN_MONTHS=["january","february","march","april","may","june","july","august","september","october","november","december"]
SPOKEN_YES_NO=["yes","yeah","yep","correct","right","no","nope","wrong"]

def words_to_digits(text):
    """'four one one one', 'forty one eleven', 'double five', '4111 1111' -> digit string.

    Returns None when the answer contains anything that isn't a number (so a misheard
    sentence is asked again instead of turning into a wrong card).
    """
    tokens=re.findall(r"[a-z]+|\d+",str(text).lower().replace("-"," "))
    out="";repeat=1;i=0
    filler={"and","uh","um","umm","er","it","its","is","my","the","number","card","code","zip","a"}
    while i<len(tokens):
        token=tokens[i]
        if token.isdigit():
            out+=token*repeat if len(token)==1 else token;repeat=1
        elif token in REPEAT_WORDS:
            repeat=REPEAT_WORDS[token]
        elif token in DIGIT_WORDS:
            out+=DIGIT_WORDS[token]*repeat;repeat=1
        elif token in TEEN_WORDS:
            out+=TEEN_WORDS[token];repeat=1
        elif token in TENS_WORDS:
            # "forty one" -> 41, "forty" -> 40
            following=tokens[i+1] if i+1<len(tokens) else ""
            if following in DIGIT_WORDS and DIGIT_WORDS[following]!="0" and following not in ("oh","o","owe","to","too","for","fore","won","ate"):
                out+=TENS_WORDS[token]+DIGIT_WORDS[following];i+=1
            else:
                out+=TENS_WORDS[token]+"0"
            repeat=1
        elif token=="hundred":
            if not out:return None
            following=tokens[i+1] if i+1<len(tokens) else ""
            # "four hundred" -> 400, "four hundred twelve" -> 412, "four hundred five" -> 405
            if following in TEEN_WORDS or following in TENS_WORDS:pass
            elif following in DIGIT_WORDS:out+="0"
            else:out+="00"
        elif token in filler:
            pass
        else:
            return None
        i+=1
    return out

def parse_expiry(text,today=None):
    """'oh four twenty eight', 'April 2028', '4 28', '0428', 'four slash two thousand twenty eight' -> 'MMYY'."""
    today=today or datetime.date.today()
    lowered=str(text).lower().replace("/"," ").replace("slash"," ")
    month=None
    for word,number in MONTHS.items():
        if re.search(rf"\b{word}\b",lowered):
            month=number;lowered=re.sub(rf"\b{word}\b"," ",lowered);break
    lowered=re.sub(r"\btwo thousand\b","20",lowered)
    lowered=re.sub(r"\b(20) and\b",r"\1",lowered)
    digits=words_to_digits(lowered)
    if digits is None:return ""
    if month is None:
        if len(digits)==6:month,year=int(digits[:2]),int(digits[4:])          # 04 2028
        elif len(digits)==5:month,year=int(digits[:1]),int(digits[3:])        # 4 2028
        elif len(digits)==4:month,year=int(digits[:2]),int(digits[2:])        # 04 28
        elif len(digits)==3:month,year=int(digits[:1]),int(digits[1:])        # 4 28
        else:return ""
    else:
        if len(digits)==4 and digits.startswith("20"):year=int(digits[2:])
        elif len(digits)==2:year=int(digits)
        else:return ""
    if not 1<=month<=12:return ""
    full=2000+year
    if (full,month)<(today.year,today.month) or full>today.year+20:return ""
    return f"{month:02d}{year:02d}"

def yes_or_no(text):
    words=set(re.findall(r"[a-z]+",str(text).lower()))
    if words&NO_WORDS:return False
    if words&YES_WORDS:return True
    return None

def valid_luhn(value):
    total=0;alternate=False
    for character in reversed(value):
        number=int(character)
        if alternate:
            number*=2
            if number>9:number-=9
        total+=number;alternate=not alternate
    return total%10==0

def card_length(prefix):
    return 15 if prefix.startswith(("34","37")) else 16

def card_complete(digits):
    return len(digits)==card_length(digits) and valid_luhn(digits)

# ---------------------------------------------------------------- Asterisk I/O

def agi(command):
    sys.stdout.write(command+"\n");sys.stdout.flush()
    return sys.stdin.readline().strip()

def agi_result(response):
    match=re.search(r"result=(-?\d+)",response)
    return int(match.group(1)) if match else -1

def _drain_audio(stop):
    """Keep EAGI's media pipe flowing while Asterisk plays a prompt."""
    while not stop.is_set():
        ready,_,_=select.select([3],[],[],0.05)
        if ready:
            try:os.read(3,3200)
            except BlockingIOError:pass

def playback(command):
    stop=threading.Event();worker=threading.Thread(target=_drain_audio,args=(stop,),daemon=True)
    worker.start()
    try:return agi(command)
    finally:
        stop.set();worker.join(timeout=0.25)

def prompt(name,interruptible=False):
    """Play a prompt; with interruptible=True a key press stops it and is returned."""
    response=playback(f'STREAM FILE voice-payment/{name} "{"0123456789#*" if interruptible else ""}"')
    value=agi_result(response)
    return chr(value) if value>0 else ""

def say_digits(value):
    return playback(f'SAY DIGITS {value} ""')

def discard_prompt_echo():
    """Drop audio queued while the prompt played (never sleep: callers answer immediately)."""
    pending=array("i",[0]);fcntl.ioctl(3,termios.FIONREAD,pending,True)
    remaining=pending[0]
    while remaining>0:
        chunk=os.read(3,min(remaining,32000))
        if not chunk:break
        remaining-=len(chunk)

def wait_digit(ms):
    value=agi_result(agi(f"WAIT FOR DIGIT {ms}"))
    return chr(value) if value>0 else ""

def collect_keys(first,max_digits,gap_ms=5000):
    """Keypad entry: digits until #, max_digits, or a pause."""
    digits="" if first in "#*" else first
    if first=="#":return digits
    while len(digits)<max_digits:
        key=wait_digit(gap_ms)
        if not key or key=="#":break
        if key=="*":digits="";continue  # star clears and starts over
        digits+=key
    return digits

# ---------------------------------------------------------------- local speech recognition

class Recognizer:
    """Vosk with a small fixed vocabulary (numbers, months, yes/no). Without the model the line
    still works by keypad: listen() then only waits for keys."""
    _model=None
    _loading=None

    @classmethod
    def _load(cls):
        try:
            from vosk import Model,SetLogLevel
            SetLogLevel(-1);cls._model=Model(VOSK_MODEL) if os.path.isdir(VOSK_MODEL) else False
        except Exception:
            cls._model=False

    @classmethod
    def preload(cls):
        """The model takes about a second to load: start it while the first prompt plays."""
        if cls._loading is None:
            cls._loading=threading.Thread(target=cls._load,daemon=True);cls._loading.start()

    @classmethod
    def available(cls):
        cls.preload();cls._loading.join()
        return bool(cls._model)

    def __init__(self,phrases):
        from vosk import KaldiRecognizer
        self.engine=KaldiRecognizer(Recognizer._model,RATE,json.dumps([*phrases,"[unk]"]));self.parts=[]
        self.engine.SetMaxAlternatives(ALTERNATIVES)

    @staticmethod
    def _alternatives(raw):
        result=json.loads(raw)
        texts=[alt.get("text","") for alt in result.get("alternatives",[])] or [result.get("text","")]
        cleaned=[" ".join(word for word in text.split() if word!="[unk]") for text in texts]
        return list(dict.fromkeys(cleaned)) or [""]

    def feed(self,chunk):
        # Vosk closes a segment at each pause ("4111, 1111, ..."): keep every segment, not just the last.
        if self.engine.AcceptWaveform(chunk):self.parts.append(self._alternatives(self.engine.Result()))

    def candidates(self):
        """What was heard, best guess first, then Vosk's next-best guesses (a missed "six six" in a zip
        usually shows up in the second or third)."""
        self.parts.append(self._alternatives(self.engine.FinalResult()))
        parts=[part for part in self.parts if any(part)] or [[""]]
        combos=[("",0)]
        for part in parts[:6]:
            combos=sorted(((f"{text} {alt}".strip(),rank+index) for text,rank in combos for index,alt in enumerate(part[:ALTERNATIVES])),key=lambda item:item[1])[:50]
        return list(dict.fromkeys(text for text,_ in combos))

    def text(self):
        return self.candidates()[0]

def _record_audio(stop,chunks):
    """Like _drain_audio, but keeps what the caller says while a prompt plays (they often answer over it)."""
    while not stop.is_set():
        ready,_,_=select.select([3],[],[],0.05)
        if ready:
            try:chunks.append(os.read(3,3200))
            except BlockingIOError:pass

def prompt_and_record(name):
    """Play an answerable prompt. Returns (key pressed, audio the caller spoke during it)."""
    chunks=[];stop=threading.Event();worker=threading.Thread(target=_record_audio,args=(stop,chunks),daemon=True)
    worker.start()
    try:value=agi_result(agi(f'STREAM FILE voice-payment/{name} "0123456789#*"'))
    finally:
        stop.set();worker.join(timeout=0.25)
    return (chr(value) if value>0 else ""),b"".join(chunks)

def listen(phrases,max_keys,max_seconds=20,silence_end=1.8,voice_level=120,preroll=b""):
    """Listen for speech and keypad at the same time. Returns ('keys'|'speech'|'none', value).
    preroll is audio the caller already spoke over the prompt; it counts as the start of the answer."""
    if not preroll:discard_prompt_echo()
    if not Recognizer.available():
        key=wait_digit(int(max_seconds*1000))
        return ("keys",collect_keys(key,max_keys)) if key else ("none","")
    recognizer=Recognizer(phrases)
    state={"started":False,"last_voice":time.monotonic(),"done":False}
    if preroll:
        # Feed what was said over the prompt; the end-of-answer clock starts from its last voiced chunk.
        quiet=0
        for index in range(0,len(preroll),3200):
            chunk=preroll[index:index+3200]
            if audioop.rms(chunk,2)>voice_level:state["started"]=True;quiet=0
            else:quiet+=len(chunk)
            recognizer.feed(chunk)
        state["last_voice"]=time.monotonic()-quiet/(RATE*2)
    stop=threading.Event()
    def reader():
        deadline=time.monotonic()+max_seconds
        while not stop.is_set() and time.monotonic()<deadline:
            ready,_,_=select.select([3],[],[],0.1)
            if not ready:
                if state["started"] and time.monotonic()-state["last_voice"]>silence_end:break
                continue
            try:chunk=os.read(3,3200)
            except BlockingIOError:continue
            if not chunk:break
            if audioop.rms(chunk,2)>voice_level:state["started"]=True;state["last_voice"]=time.monotonic()
            recognizer.feed(chunk)
            if state["started"] and time.monotonic()-state["last_voice"]>silence_end:break
        state["done"]=True
    worker=threading.Thread(target=reader,daemon=True);worker.start()
    key=""
    try:
        while not state["done"]:
            key=wait_digit(200)
            if key:break
    finally:
        stop.set();worker.join(timeout=1)
    if key:return "keys",collect_keys(key,max_keys)
    heard=recognizer.candidates() if state["started"] else []
    return ("speech",heard) if heard and heard[0] else ("none","")

NUMBER_PHRASES=SPOKEN_NUMBERS

def ask(prompt_name,phrases,max_keys,**options):
    pressed,spoken=prompt_and_record(prompt_name)
    if pressed:return "keys",collect_keys(pressed,max_keys)
    return listen(phrases,max_keys,preroll=spoken,**options)

# ---------------------------------------------------------------- flow

def card_groups(prefix):
    """How a card is read in groups: Amex 4-6-5, everything else 4-4-4-4."""
    return [4,6,5] if card_length(prefix)==15 else [4,4,4,4]

def group_prompt(index,size,remaining):
    if index==0:return "card-number"
    if size==remaining:return {4:"last-four",5:"last-five"}.get(size,"next-four")
    return "next-six" if size==6 else "next-four"

def best(how,heard,convert,ok):
    """Keys are taken as typed. Speech: the best guess, or for short answers (zip, code, expiry, a group)
    the first of Vosk's next-best guesses that has the right shape. Never used for the whole card
    number, where a second guess could be a different valid card."""
    if how=="keys":
        value=convert(heard)
        return value if value and ok(value) else ""
    for text in heard:
        value=convert(text)
        if value and ok(value):return value
    return ""

as_digits=lambda text:text if text.isdigit() else (words_to_digits(text) or "")

def card_in_groups():
    """Four digits at a time (Amex 4-6-5). Short answers are the easiest to hear correctly."""
    card=""
    for index in range(4):
        sizes=card_groups(card or "4");size=sizes[index]
        group=""
        for _ in range(3):
            how,heard=ask(group_prompt(index,size,sum(sizes)-len(card)),NUMBER_PHRASES,19 if index==0 else size,max_seconds=12,silence_end=1.6)
            if index==0 and how=="keys" and card_complete(heard):return heard  # keyed the whole number
            group=best(how,heard,as_digits,lambda value,size=size:len(value)==size)
            if len(group)==size:break
            prompt("try-again");group=""
        if not group:return ""
        card+=group
        if len(card)==sum(card_groups(card)):return card if valid_luhn(card) else ""
    return ""

def get_card_number():
    """The whole number in one go, spoken or keyed. If it doesn't come out as a valid card
    (a dropped or extra digit fails the Luhn check), fall back to four digits at a time."""
    how,heard=ask("say-card-number",NUMBER_PHRASES,19,max_seconds=30,silence_end=2.2)
    digits=heard if how=="keys" else words_to_digits(heard[0]) or "" if heard else ""
    if card_complete(digits):return digits
    for _ in range(2):
        prompt("card-in-groups")
        digits=card_in_groups()
        if digits:return digits
        prompt("card-invalid")
    return ""

def get_expiry():
    for _ in range(3):
        how,heard=ask("say-expiration",[*SPOKEN_NUMBERS,"thousand",*SPOKEN_MONTHS],6,max_seconds=12)
        expiry=best(how,heard,parse_expiry,bool)
        if expiry:return expiry
        prompt("try-again")
    return ""

def get_digits(prompt_name,lengths,max_seconds=12):
    for _ in range(3):
        how,heard=ask(prompt_name,NUMBER_PHRASES,max(lengths),max_seconds=max_seconds)
        digits=best(how,heard,as_digits,lambda value:len(value) in lengths)
        if digits:return digits
        prompt("try-again")
    return ""

def api(payload):
    request=urllib.request.Request(API,data=json.dumps(payload,separators=(",",":")).encode(),headers={"content-type":"application/json","x-voice-payment-secret":SECRET},method="POST")
    try:
        # Longer than the server's worst case (MX token 12 s + sale 20 s + lookup 12 s), so the
        # line never gives up on a charge the server is still completing.
        with urllib.request.urlopen(request,timeout=60) as response:return json.loads(response.read())
    except urllib.error.HTTPError as error:
        try:message=json.loads(error.read()).get("error","")
        except Exception:message=""
        raise RuntimeError(message or "Payment service rejected the request")

def main():
    environment={}
    while True:
        line=sys.stdin.readline().rstrip("\n")
        if not line:break
        if ": " in line:
            key,value=line.split(": ",1);environment[key]=value
    Recognizer.preload()
    agi("ANSWER")
    session=None;failure_stage="claim_failed"
    try:
        call_id=sys.argv[1].strip() if len(sys.argv)>1 else ""
        verified_caller=sys.argv[2].strip() if len(sys.argv)>2 else ""
        session=api({"action":"claim","callId":call_id,"callerPhone":verified_caller or environment.get("agi_callerid","")})
        # No read-back of the last four (owner request 2026-10-25): a misheard number fails the card check
        # and is asked again; the processor declines a wrong one.
        failure_stage="card_recognition_failed"
        card=get_card_number()
        if not card:raise RuntimeError("recognition")
        failure_stage="expiration_recognition_failed"
        expiry=get_expiry()
        if not expiry:raise RuntimeError("recognition")
        failure_stage="security_code_recognition_failed"
        cvv=get_digits("say-security-code",(4,) if len(card)==15 else (3,))
        if not cvv:raise RuntimeError("recognition")
        failure_stage="billing_zip_recognition_failed"
        zipcode=get_digits("say-billing-zip",(5,))
        if not zipcode:raise RuntimeError("recognition")
        prompt("processing")
        failure_stage="provider_payment_failed"
        api({"action":"charge","sessionId":session["sessionId"],"cardNumber":card,"expiryMonth":expiry[:2],"expiryYear":expiry[2:],"cvv":cvv,"avsZip":zipcode})
        card=expiry=cvv=zipcode=""
        prompt("approved");agi("SET VARIABLE VOICE_PAYMENT_RESULT approved")
    except Exception:
        if session:
            try:api({"action":"abandon","sessionId":session["sessionId"],"code":failure_stage})
            except Exception as cleanup_error:
                # Never include exception text: an upstream library could place request data in it.
                sys.stderr.write(f"VOICE_PAYMENT_CLEANUP_ERROR type={type(cleanup_error).__name__}\n");sys.stderr.flush()
        prompt("employee-help");agi("SET VARIABLE VOICE_PAYMENT_RESULT failed")

def self_test():
    today=datetime.date(2026,10,25)
    cases={
        "four one one one one one one one one one one one one one one one":"4111111111111111",
        "four one one one, one one one one, one one one one, one one one one":"4111111111111111",
        "forty one eleven eleven eleven eleven eleven eleven eleven":"4111111111111111",
        "four one double one one one one one triple one one one one one one":"4111111111111111",
        "4111 1111 1111 1111":"4111111111111111",
        "three seven eight two eight two two four six three one oh oh oh five":"378282246310005",
        "five five five five five five five five four four four four four four four four":"5555555544444444",
        "uh four two four two four two four two four two four two four two four two":"4242424242424242",
        "one two three":"123",
        "nineteen":"19",
        "four hundred twelve":"412",
    }
    for spoken,expected in cases.items():
        assert words_to_digits(spoken)==expected,(spoken,words_to_digits(spoken))
    assert words_to_digits("four one one one pizza")is None
    for spoken,expected in {"oh four twenty eight":"0428","april twenty twenty eight":"0428","april 2028":"0428",
        "four slash twenty eight":"0428","0428":"0428","4 28":"0428","twelve thirty":"1230",
        "december two thousand twenty nine":"1229","one two two eight":"1228","ten twenty six":"1026"}.items():
        assert parse_expiry(spoken,today)==expected,(spoken,parse_expiry(spoken,today))
    for bad in ("thirteen twenty eight","oh four twenty five","nine twenty six","april","one"):
        assert parse_expiry(bad,today)=="",(bad,parse_expiry(bad,today))
    assert yes_or_no("yes that's right") is True and yes_or_no("no") is False and yes_or_no("um") is None
    assert card_complete("4111111111111111") and card_complete("378282246310005") and not card_complete("4111111111111112")
    assert card_length("3782")==15 and card_length("4111")==16
    sys.stdout.write(json.dumps({"status":"passed","parsing":True})+"\n")

if __name__=="__main__":
    self_test() if "--self-test" in sys.argv else main()
