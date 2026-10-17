#!/usr/bin/env python3
"""Isolated keypad card-payment AGI; sensitive digits are never logged."""
import json
import os
import re
import select
import sys
import threading
import urllib.error
import urllib.request

API=os.environ.get("VOICE_PAYMENT_API_URL","http://127.0.0.1:3000/api/internal/voice-payment")
SECRET=os.environ.get("VOICE_PAYMENT_INTERNAL_SECRET","")

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

def keypad(prompt_name,timeout_ms,max_digits):
    """Collect keypad digits without logging or exposing the returned value."""
    # EAGI continues writing inbound media to fd 3 while GET DATA listens for
    # DTMF. Drain that unused audio or its pipe fills and Asterisk can no longer
    # play the prompt or reliably wait for digits.
    stop=threading.Event();worker=threading.Thread(target=_drain_audio,args=(stop,),daemon=True)
    worker.start()
    try:response=agi(f'GET DATA voice-payment/{prompt_name} {timeout_ms} {max_digits}')
    finally:
        stop.set();worker.join(timeout=0.25)
    match=re.search(r'result=([0-9]*)',response)
    return match.group(1) if match else ""

def api(payload):
    request=urllib.request.Request(API,data=json.dumps(payload,separators=(",",":")).encode(),headers={"content-type":"application/json","x-voice-payment-secret":SECRET},method="POST")
    try:
        with urllib.request.urlopen(request,timeout=25) as response:return json.loads(response.read())
    except urllib.error.HTTPError as error:
        try: message=json.loads(error.read()).get("error","")
        except Exception: message=""
        raise RuntimeError(message or "Payment service rejected the request")

def enter_card_number():
    value=keypad("dtmf-card-number",20000,19)
    return value if len(value) in (15,16) else ""

def valid_luhn(value):
    total=0;alternate=False
    for character in reversed(value):
        number=int(character)
        if alternate:
            number*=2
            if number>9:number-=9
        total+=number;alternate=not alternate
    return total%10==0

def enter_expiration():
    for _ in range(3):
        value=keypad("dtmf-expiration",12000,4)
        if len(value)==4 and 1<=int(value[:2])<=12:return value
        prompt("try-again")
    return ""

def confirmed(last4):
    prompt("confirm-ending");say_digits(last4)
    return keypad("dtmf-confirm",10000,1)=="1"

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
            card=enter_card_number()
            if not card or not valid_luhn(card):
                card=""
                prompt("try-again")
                continue
            failure_stage="card_confirmation_failed"
            if confirmed(card[-4:]):break
            card=""
            prompt("try-again")
        if not card:raise RuntimeError("recognition")
        failure_stage="expiration_recognition_failed"
        expiry=enter_expiration()
        if not expiry: raise RuntimeError("recognition")
        failure_stage="security_code_recognition_failed"
        cvv=keypad("dtmf-security-code",12000,4)
        if len(cvv) not in (3,4):cvv=""
        if not cvv: raise RuntimeError("recognition")
        failure_stage="billing_zip_recognition_failed"
        zipcode=keypad("dtmf-billing-zip",12000,5)
        if len(zipcode)!=5:zipcode=""
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
