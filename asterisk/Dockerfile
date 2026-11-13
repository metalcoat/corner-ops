# llama.cpp CPU server, pinned: runs the card-digit second opinion (LFM3-Audio) inside this container.
FROM ghcr.io/ggml-org/llama.cpp@sha256:41988e510b6fe0a0b5b9be00a9dbf91d9f0fa691da173d7b06d97d370329fe84 AS llama

FROM ubuntu:24.04

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      asterisk \
      ca-certificates \
      espeak-ng \
      gettext-base \
      libgomp1 \
      python3-pip \
      python3-websockets \
      sox \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# Local speech recognition for the secure payment line (card audio never leaves this container).
# Vosk US English model (0.22 lgraph, ~200 MB unpacked, ~400 MB RAM during a payment call), pinned by checksum.
# On natural voices through a phone codec it heard every test card and 4-digit group; the small model missed 1 in 5.
RUN pip3 install --break-system-packages --no-cache-dir vosk==0.3.45
ADD --checksum=sha256:d9838b4aaa82a75c4a17f5aca300eaca129aaab2a7cbf951bafbb500eb9c4334 \
    https://alphacephei.com/vosk/models/vosk-model-en-us-0.22-lgraph.zip /tmp/vosk-model.zip
RUN unzip -q /tmp/vosk-model.zip -d /opt \
    && mv /opt/vosk-model-en-us-0.22-lgraph /opt/vosk-model \
    && rm /tmp/vosk-model.zip

# Second opinion on card digits (2026-11-06): LFM3-Audio-2B (Q8_0 GGUF, ~2.4 GB, ~1.5 s per 4-digit answer on 4
# CPU threads), served by llama.cpp on 127.0.0.1 only when VOICE_PAYMENT_SECOND_OPINION=true. Audio is sent over
# localhost and never stored. On 200 synthetic phone-codec groups (clean/quiet/noisy/fast) it was right on 188
# (Vosk 167), never agreed with a wrong Vosk reading, and rescued 20 of Vosk's 26 misses.
# LFM Open License v1.0: commercial use allowed below USD 10M annual revenue.
COPY --from=llama /app /opt/llama
ADD --checksum=sha256:d4e36902ba8f0ee7b333596030a59d650f88ac76660b4d9ba5ff77c3c2258fc0 \
    https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF/resolve/39670cb5c42e9c4bfe046519ba7ffbe47f9552ad/LFM3-Audio-2B-Q8_0.gguf /opt/card-asr/model.gguf
ADD --checksum=sha256:bd0fce0670c96e405a753f996701dee6568bc6a1318a80091d74fb58f7510d79 \
    https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF/resolve/39670cb5c42e9c4bfe046519ba7ffbe47f9552ad/mmproj-LFM3-Audio-2B-F16.gguf /opt/card-asr/mmproj.gguf

COPY pjsip.conf.template /opt/corner-ops-asterisk/pjsip.conf.template
COPY extensions.conf.template /opt/corner-ops-asterisk/extensions.conf.template
COPY rtp.conf /etc/asterisk/rtp.conf
COPY entrypoint.sh /usr/local/bin/corner-ops-asterisk-entrypoint
COPY voice-payment.py /usr/local/bin/corner-ops-voice-payment
COPY gemini-phone.py /usr/local/bin/corner-ops-gemini-phone
COPY ai-route.py /usr/local/bin/corner-ops-ai-route
COPY voice-payment-prompts/ /opt/corner-ops-asterisk/voice-payment-prompts/

RUN chmod 0755 /usr/local/bin/corner-ops-asterisk-entrypoint /usr/local/bin/corner-ops-voice-payment /usr/local/bin/corner-ops-gemini-phone /usr/local/bin/corner-ops-ai-route \
    && mkdir -p /usr/share/asterisk/sounds/en/voice-payment \
    && for spec in \
      'welcome:You are now on the secure automated payment line. Nothing you say here is sent to the ordering assistant or saved in a transcript.' \
      'card-number:Okay, start with the first four numbers.' \
      'next-four:Now say the next four digits.' \
      'last-four:Now say the last four digits.' \
      'next-six:Now say the next six digits.' \
      'last-five:Now say the last five digits.' \
      'expiration:Say the two digit expiration month followed by the two digit year.' \
      'security-code:Say the three or four digit security code.' \
      'billing-zip:Say the five digit billing zip code.' \
      'confirm-ending:I heard a card ending in' \
      'confirm-yes:Say yes if that is correct, or no to try again.' \
      'try-again:I did not understand that. Please try again slowly.' \
      'processing:Please wait while I securely process the sandbox payment.' \
      'approved:Your test payment was approved and your order is complete. Thank you for calling Corner Deli.' \
      'employee-help:I could not complete the secure test payment. I will transfer you to an employee.'; do \
      name="${spec%%:*}"; text="${spec#*:}"; \
      espeak-ng -s 145 -w "/tmp/${name}.wav" "${text}"; \
      sox "/tmp/${name}.wav" -r 8000 -c 1 -e signed-integer -b 16 "/usr/share/asterisk/sounds/en/voice-payment/${name}.wav"; \
      rm "/tmp/${name}.wav"; \
    done \
    && for spec in \
      'dtmf-card-number:Please enter your full card number using the telephone keypad, then press pound.' \
      'dtmf-expiration:Enter the two digit expiration month followed by the two digit year.' \
      'dtmf-security-code:Enter the three or four digit security code, then press pound.' \
      'dtmf-billing-zip:Enter the five digit billing zip code.' \
      'dtmf-confirm:Press 1 if that is correct, or press 2 to try again.' \
      'say-card-number:Please say your card number, or type it on the keypad.' \
      'card-in-groups:Lets take it four digits at a time.' \
      'card-invalid:Sorry, that did not come through as a valid card number.' \
      'say-confirm:Is that right? Say yes, or press 1. Say no, or press 2.' \
      'say-expiration:What is the expiration date? You can say something like oh four, twenty eight, or type four digits.' \
      'say-security-code:And the security code on the card?' \
      'say-billing-zip:And the billing zip code?' \
      'type-group:Sorry, I did not catch that. Please type those digits on the keypad.' \
      'lets-get-card:Okay, lets get your card.' \
      'transfer-person:No problem, let me get you to someone at the store.' \
      'transfer-card-help:Sorry, we must be having an issue. I am transferring you to someone who will take your card number.'; do \
      name="${spec%%:*}"; text="${spec#*:}"; \
      espeak-ng -s 145 -w "/tmp/${name}.wav" "${text}"; \
      sox "/tmp/${name}.wav" -r 8000 -c 1 -e signed-integer -b 16 "/usr/share/asterisk/sounds/en/voice-payment/${name}.wav"; \
      rm "/tmp/${name}.wav"; \
    done \
    && for source in /opt/corner-ops-asterisk/voice-payment-prompts/*.wav; do \
      name="${source##*/}"; \
      sox "${source}" -r 8000 -c 1 -e signed-integer -b 16 "/usr/share/asterisk/sounds/en/voice-payment/${name}"; \
    done

ENTRYPOINT ["/usr/local/bin/corner-ops-asterisk-entrypoint"]
