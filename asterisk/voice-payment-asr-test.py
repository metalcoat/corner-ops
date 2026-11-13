"""Speech regression test for the secure payment line (asterisk/voice-payment.py) with Vosk.

Composes natural-voice clips (one word each, tests/fixtures/payment-voice, made with Gemini TTS) into
spoken card numbers with natural pauses, passes them through a phone codec (8 kHz mu-law) and checks
what the recognizer + parser hear. Synthetic voices, not real callers.
Run inside the phone image: python3 voice-payment-asr-test.py voice-payment.py <clips dir>
"""
import importlib.machinery,importlib.util,subprocess,sys,json,warnings,os,random,glob
warnings.filterwarnings("ignore")
loader=importlib.machinery.SourceFileLoader("vp",sys.argv[1]);spec=importlib.util.spec_from_loader("vp",loader);vp=importlib.util.module_from_spec(spec);loader.exec_module(vp)
words_dir=sys.argv[2];random.seed(int(os.environ.get("SEED","11")))
assert vp.Recognizer.available()
voices=sorted({os.path.basename(p).split("--")[0] for p in glob.glob(f"{words_dir}/*--*.wav")})
NAMES=["zero","one","two","three","four","five","six","seven","eight","nine"]
cache={}
def clip(voice,word):
    key=(voice,word)
    if key not in cache:
        src=f"{words_dir}/{voice}--{word}.wav"
        if not os.path.exists(src):return None
        # trim leading/trailing silence, resample to 16k mono
        cache[key]=subprocess.run(f"sox '{src}' -r 16000 -c 1 -e signed-integer -b 16 -t raw - silence 1 0.02 1% reverse silence 1 0.02 1% reverse",shell=True,capture_output=True,check=True).stdout
    return cache[key]
def silence(seconds):return b"\x00\x00"*int(16000*seconds)
def phone(raw):
    p=subprocess.run("sox -t raw -r 16000 -e signed-integer -b 16 -c 1 - -r 8000 -e mu-law -t wav - | sox -t wav - -r 16000 -e signed-integer -b 16 -t raw -",shell=True,input=raw,capture_output=True,check=True)
    return p.stdout
def speak(voice,groups):
    out=silence(0.5)
    for gi,group in enumerate(groups):
        for wi,word in enumerate(group):
            c=clip(voice,word)
            if c is None:return None
            out+=c+silence(random.uniform(0.05,0.18))
        out+=silence(random.uniform(0.35,0.75))
    return phone(out+silence(0.8))
def hear(raw,phrases):
    r=vp.Recognizer(phrases)
    for i in range(0,len(raw),3200):r.feed(raw[i:i+3200])
    return r.text()
def luhn_card(prefix,length):
    body=prefix+"".join(random.choice("0123456789") for _ in range(length-len(prefix)-1))
    for d in "0123456789":
        if vp.valid_luhn(body+d):return body+d
def say_digit(d,oh):return "oh" if d=="0" and oh else NAMES[int(d)]
res={"whole_ok":0,"whole_wrong_valid":0,"whole_total":0,"group_ok":0,"group_total":0,"exp_ok":0,"exp_total":0,"yn_ok":0,"yn_total":0}
samples=[]
for n in range(int(os.environ.get("N","150"))):
    voice=random.choice(voices);oh=random.random()<0.4
    amex=n%6==5
    card=luhn_card(random.choice(["34","37"]) if amex else random.choice(["4","51","55","6011"]),15 if amex else 16)
    sizes=[4,6,5] if amex else [4,4,4,4];parts=[];i=0
    for s in sizes:parts.append(card[i:i+s]);i+=s
    raw=speak(voice,[[say_digit(d,oh) for d in p] for p in parts])
    if raw is None:continue
    got=vp.words_to_digits(hear(raw,vp.SPOKEN_NUMBERS)) or ""
    res["whole_total"]+=1
    if got==card:res["whole_ok"]+=1
    elif vp.card_complete(got):res["whole_wrong_valid"]+=1
    else:samples.append([voice,card[-6:],got[-6:],len(got)])
    for p in parts[:2]:
        if len(p)!=4:continue
        graw=speak(voice,[[say_digit(d,oh) for d in p]])
        res["group_total"]+=1
        if (vp.words_to_digits(hear(graw,vp.SPOKEN_NUMBERS)) or "")==p:res["group_ok"]+=1
# Zip codes and security codes use Vosk's next-best guesses when the best one has the wrong length.
res["zip_ok"]=res["zip_total"]=0
for n in range(40):
    voice=random.choice(voices);zipcode="".join(random.choice("0123456789") for _ in range(5))
    if n%4==0:zipcode=zipcode[:2]+zipcode[2]*2+zipcode[4]  # doubled digits, like 13669
    raw=speak(voice,[[say_digit(d,False) for d in zipcode]])
    if raw is None:continue
    r=vp.Recognizer(vp.SPOKEN_NUMBERS)
    for i in range(0,len(raw),3200):r.feed(raw[i:i+3200])
    res["zip_total"]+=1
    if vp.best("speech",r.candidates(),vp.as_digits,lambda value:len(value)==5)==zipcode:res["zip_ok"]+=1
    else:samples.append([voice,"zip",zipcode])
for voice in voices:
    for words,exp in [(["oh","four","twenty_eight"],"0428"),(["twelve","thirty"],"1230"),(["September","twenty_twenty_seven"],"0927"),(["one","two","two","eight"],"1228"),(["four","twenty_eight"],"0428")]:
        raw=speak(voice,[words])
        if raw is None:continue
        res["exp_total"]+=1;heard=hear(raw,[*vp.SPOKEN_NUMBERS,"thousand",*vp.SPOKEN_MONTHS])
        if vp.parse_expiry(heard)==exp:res["exp_ok"]+=1
        else:samples.append([voice,"exp",exp,heard])
    for word,want in [("yes",True),("no",False)]:
        raw=speak(voice,[[word]])
        if raw is None:continue
        res["yn_total"]+=1
        if vp.yes_or_no(hear(raw,vp.SPOKEN_YES_NO))==want:res["yn_ok"]+=1
summary={"voices":voices,**res,"misses":samples[:12]}
sys.stdout.write(json.dumps(summary)+"\n")
# A wrong-but-valid card must never come out; nearly every number and group is heard.
assert len(voices)>=4,summary
assert res["whole_wrong_valid"]==0,summary
assert res["whole_total"]>=40 and res["whole_ok"]>=0.9*res["whole_total"],summary
assert res["group_ok"]>=0.95*res["group_total"],summary
assert res["zip_ok"]>=0.95*res["zip_total"],summary
assert res["exp_ok"]>=res["exp_total"]-2 and res["yn_ok"]>=res["yn_total"]-1,summary
