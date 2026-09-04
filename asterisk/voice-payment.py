#!/usr/bin/env python3
"""Isolated sandbox voice-card AGI. Never log recognized speech or request bodies."""
import audioop
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
WORDS={"zero":"0","oh":"0","one":"1","two":"2","three":"3","four":"4","five":"5","six":"6","seven":"7","eight":"8","nine":"9"}

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

def prompt(name):
    # STREAM FILE is synchronous, but Asterisk continues writing inbound phone
    # audio to fd 3. Drain it concurrently so the pipe cannot fill and break
    # prompt playback. Prompt-time audio is intentionally ignored.
    stop=threading.Event();worker=threading.Thread(target=_drain_audio,args=(stop,),daemon=True)
    worker.start()
    try: agi(f'STREAM FILE voice-payment/{name} ""')
    finally:
        stop.set();worker.join(timeout=0.25)

def discard_prompt_echo():
    """Discard audio accumulated on EAGI fd 3 while a prompt was playing."""
    for delay in (0,0.2):
        if delay:time.sleep(delay)
        pending=array("i",[0]);termios.ioctl(3,termios.FIONREAD,pending,True)
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
        if level>260: started=True;last_voice=time.monotonic()
        recognizer.process_raw(chunk,False,False)
        if started and time.monotonic()-last_voice>2.0: break
    recognizer.end_utt();hyp=recognizer.hyp()
    return hyp.hypstr.lower().split() if hyp else []

def hear_digits(minimum,maximum,prompt_name,attempts=3):
    sequence="(<digit>)+";grammar="<digit> = zero | oh | one | two | three | four | five | six | seven | eight | nine; public <input> = "+sequence
    # PocketSphinx accepts one public rule, so use an inline alternation for streaming digit recognition.
    search="(zero | oh | one | two | three | four | five | six | seven | eight | nine)+"
    for _ in range(attempts):
        prompt(prompt_name);discard_prompt_echo();value="".join(WORDS[word] for word in hear(search) if word in WORDS)
        if minimum<=len(value)<=maximum:return value
        prompt("try-again")
    return ""

def hear_card_number():
    first=hear_digits(4,4,"card-number")
    if not first:return ""
    if first.startswith(("34","37")):
        middle=hear_digits(6,6,"next-six")
        final=hear_digits(5,5,"last-five")
        return first+middle+final if middle and final else ""
    second=hear_digits(4,4,"next-four")
    third=hear_digits(4,4,"next-four")
    fourth=hear_digits(4,4,"last-four")
    return first+second+third+fourth if second and third and fourth else ""

def confirmed(last4):
    prompt("confirm-ending");agi(f'SAY DIGITS {last4} ""');prompt("confirm-yes")
    words=hear("yes | correct | no | incorrect",7)
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
        failure_stage="card_recognition_failed"
        card=hear_card_number()
        if not card: raise RuntimeError("recognition")
        failure_stage="card_confirmation_failed"
        if not confirmed(card[-4:]): raise RuntimeError("recognition")
        failure_stage="expiration_recognition_failed"
        expiry=hear_digits(4,4,"expiration")
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
            except Exception: pass
        prompt("employee-help");agi("SET VARIABLE VOICE_PAYMENT_RESULT failed")

if __name__=="__main__": main()
