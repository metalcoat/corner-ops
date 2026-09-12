#!/usr/bin/env python3
"""Isolated voice-card AGI. Recognition text is visible only in explicit sandbox debug mode."""
import audioop
import fcntl
import json
import os
import select
import sys
import termios
import threading
import time
import urllib.error
import urllib.request
from array import array
from pocketsphinx import Decoder, get_model_path

API=os.environ.get("VOICE_PAYMENT_API_URL","http://127.0.0.1:3000/api/internal/voice-payment")
SECRET=os.environ.get("VOICE_PAYMENT_INTERNAL_SECRET","")
SANDBOX=os.environ.get("MX_ENVIRONMENT","sandbox").strip().lower()!="production"
DEBUG_RECOGNITION=SANDBOX and os.environ.get("VOICE_PAYMENT_DEBUG_RECOGNITION","").strip().lower() in ("1","true","yes","on")
WORDS={"zero":"0","oh":"0","one":"1","two":"2","three":"3","four":"4","five":"5","six":"6","seven":"7","eight":"8","nine":"9"}

def debug_recognition(stage,value):
    if DEBUG_RECOGNITION:
        # stderr is the Asterisk container log, never the AGI command channel.
        # This deliberately exposes sandbox test digits only; production forces this off.
        sys.stderr.write(f"VOICE_PAYMENT_SANDBOX_RECOGNITION stage={stage} heard={value or '[nothing]'}\n")
        sys.stderr.flush()

def agi(command):
    sys.stdout.write(command+"\n");sys.stdout.flush()
    return sys.stdin.readline().strip()

def _drain_audio(stop):
    """Keep EAGI's nonblocking media pipe flowing while Asterisk plays a prompt."""
    while not stop.is_set():
        ready,_,_=select.select([3],[],[],0.05)
        if ready:
            try: os.read(3,3200)
            except BlockingIOError: pass

def playback(command):
    """Run any synchronous Asterisk playback while draining EAGI input."""
    stop=threading.Event();worker=threading.Thread(target=_drain_audio,args=(stop,),daemon=True)
    worker.start()
    try:return agi(command)
    finally:
        stop.set();worker.join(timeout=0.25)

def prompt(name):
    return playback(f'STREAM FILE voice-payment/{name} ""')

def say_digits(value):
    return playback(f'SAY DIGITS {value} ""')

def discard_prompt_echo():
    """Discard only bytes already queued when a prompt ends.

    Never sleep and drain again: callers commonly begin their answer immediately,
    and the old delayed drain was deleting the beginning of the next digit group.
    """
    pending=array("i",[0]);fcntl.ioctl(3,termios.FIONREAD,pending,True)
    remaining=pending[0]
    while remaining>0:
        chunk=os.read(3,min(remaining,32000))
        if not chunk:break
        remaining-=len(chunk)

def api(payload):
    request=urllib.request.Request(API,data=json.dumps(payload,separators=(",",":")).encode(),headers={"content-type":"application/json","x-voice-payment-secret":SECRET},method="POST")
    try:
        with urllib.request.urlopen(request,timeout=25) as response:return json.loads(response.read())
    except urllib.error.HTTPError as error:
        try: message=json.loads(error.read()).get("error","")
        except Exception: message=""
        raise RuntimeError(message or "Payment service rejected the request")

def decoder(search):
    model=get_model_path()
    config=Decoder.default_config()
    config.set_string("-hmm",os.path.join(model,"en-us"));config.set_string("-dict",os.path.join(model,"cmudict-en-us.dict"));config.set_float("-samprate",16000);config.set_string("-logfn","/dev/null")
    value=Decoder(config)
    grammar="#JSGF V1.0; grammar input; public <input> = "+search+";"
    value.set_jsgf_string("input",grammar);value.set_search("input")
    return value

def hear(search,max_seconds=14):
    recognizer=decoder(search);recognizer.start_utt();started=False;last_voice=time.monotonic();deadline=time.monotonic()+max_seconds
    while time.monotonic()<deadline:
        ready,_,_=select.select([3],[],[],0.25)
        if not ready: continue
        chunk=os.read(3,3200)
        if not chunk: break
        level=audioop.rms(chunk,2)
        # Narrow-band phone callers routinely arrive below the old 260 RMS
        # threshold. PocketSphinx's constrained grammar still does recognition;
        # this threshold controls only when silence ends the answer.
        if level>120: started=True;last_voice=time.monotonic()
        # Normalize quiet narrow-band calls before recognition. Limit gain to
        # avoid turning restaurant noise into speech or clipping loud callers.
        if level>0:
            chunk=audioop.mul(chunk,2,min(6.0,max(1.0,1800.0/level)))
        recognizer.process_raw(chunk,False,False)
        if started and time.monotonic()-last_voice>2.4: break
    recognizer.end_utt();hyp=recognizer.hyp()
    return hyp.hypstr.lower().split() if hyp else []

def digit_search(lengths):
    digit="(zero | oh | one | two | three | four | five | six | seven | eight | nine)"
    return "("+" | ".join(" ".join([digit]*length) for length in lengths)+")"

def hear_digits(minimum,maximum,prompt_name,attempts=3,accepted_lengths=None):
    # Exact-length alternatives prevent PocketSphinx from inserting a fifth
    # digit into a four-digit answer. The opening accepts either one group or a
    # complete common card length so callers can still speak continuously.
    lengths=accepted_lengths or list(range(minimum,maximum+1))
    search=digit_search(lengths)
    for attempt in range(attempts):
        prompt(prompt_name);discard_prompt_echo();value="".join(WORDS[word] for word in hear(search) if word in WORDS)
        debug_recognition(f"{prompt_name}:{attempt+1}",value)
        if minimum<=len(value)<=maximum:return value
        prompt("try-again")
    return ""

def hear_card_number(allow_full=True):
    # A caller may continue past the first four at their natural pace. If they
    # pause, retain everything already heard and collect only what remains.
    card=hear_digits(4,19,"card-number",accepted_lengths=[4,15,16] if allow_full else [4])
    if not card:return ""
    target=15 if card.startswith(("34","37")) else 16
    while len(card)<target:
        remaining=target-len(card)
        # Never accept a partial group. A short recognition used to shift every
        # following group and could accidentally form a different Luhn-valid
        # number before the caller rejected the read-back.
        group_size=6 if remaining==11 else 5 if remaining==5 else min(4,remaining)
        prompt_name="next-six" if group_size==6 else "last-five" if group_size==5 else "last-four" if remaining<=4 else "next-four"
        group=hear_digits(group_size,group_size,prompt_name,accepted_lengths=[group_size])
        if not group:return ""
        card+=group
    return card if len(card)==target else ""

def valid_luhn(value):
    total=0;alternate=False
    for character in reversed(value):
        number=int(character)
        if alternate:
            number*=2
            if number>9:number-=9
        total+=number;alternate=not alternate
    return total%10==0

def hear_expiration():
    for _ in range(3):
        value=hear_digits(4,4,"expiration",attempts=1)
        if len(value)==4 and 1<=int(value[:2])<=12:return value
    return ""

def confirmed(last4):
    prompt("confirm-ending");say_digits(last4);prompt("confirm-yes");discard_prompt_echo()
    words=hear("yes | correct | no | incorrect",7)
    debug_recognition("card-confirmation"," ".join(words))
    return any(word in ("yes","correct") for word in words) and not any(word in ("no","incorrect") for word in words)

def main():
    environment={}
    while True:
        line=sys.stdin.readline().rstrip("\n")
        if not line: break
        if ": " in line:
            key,value=line.split(": ",1);environment[key]=value
    agi("ANSWER")
    session=None;failure_stage="claim_failed"
    try:
        call_id=sys.argv[1].strip() if len(sys.argv)>1 else ""
        verified_caller=sys.argv[2].strip() if len(sys.argv)>2 else ""
        session=api({"action":"claim","callId":call_id,"callerPhone":verified_caller or environment.get("agi_callerid","")})
        card=""
        for card_attempt in range(3):
            failure_stage="card_recognition_failed"
            card=hear_card_number(allow_full=card_attempt==0)
            if not card or not valid_luhn(card):
                debug_recognition("card-validation","valid" if card and valid_luhn(card) else "invalid-luhn")
                card=""
                prompt("try-again")
                continue
            failure_stage="card_confirmation_failed"
            if confirmed(card[-4:]):break
            card=""
            prompt("try-again")
        if not card:raise RuntimeError("recognition")
        failure_stage="expiration_recognition_failed"
        expiry=hear_expiration()
        if not expiry: raise RuntimeError("recognition")
        failure_stage="security_code_recognition_failed"
        cvv=hear_digits(3,4,"security-code")
        if not cvv: raise RuntimeError("recognition")
        failure_stage="billing_zip_recognition_failed"
        zipcode=hear_digits(5,5,"billing-zip")
        if not zipcode: raise RuntimeError("recognition")
        prompt("processing")
        failure_stage="provider_payment_failed"
        api({"action":"charge","sessionId":session["sessionId"],"cardNumber":card,"expiryMonth":expiry[:2],"expiryYear":expiry[2:],"cvv":cvv,"avsZip":zipcode})
        card=expiry=cvv=zipcode=""
        prompt("approved");agi("SET VARIABLE VOICE_PAYMENT_RESULT approved")
    except Exception:
        if session:
            try: api({"action":"abandon","sessionId":session["sessionId"],"code":failure_stage})
            except Exception as cleanup_error:
                # Never include exception text: an upstream library could place
                # request data in it. The type is enough to diagnose cleanup.
                sys.stderr.write(f"VOICE_PAYMENT_CLEANUP_ERROR type={type(cleanup_error).__name__}\n")
                sys.stderr.flush()
        prompt("employee-help");agi("SET VARIABLE VOICE_PAYMENT_RESULT failed")

if __name__=="__main__": main()
