FROM ubuntu:24.04

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      asterisk \
      ca-certificates \
      espeak-ng \
      gettext-base \
      pocketsphinx-en-us \
      python3-pocketsphinx \
      python3-websockets \
      sox \
    && rm -rf /var/lib/apt/lists/*

COPY pjsip.conf.template /opt/corner-ops-asterisk/pjsip.conf.template
COPY extensions.conf.template /opt/corner-ops-asterisk/extensions.conf.template
COPY rtp.conf /etc/asterisk/rtp.conf
COPY entrypoint.sh /usr/local/bin/corner-ops-asterisk-entrypoint
COPY voice-payment.py /usr/local/bin/corner-ops-voice-payment
COPY gemini-phone.py /usr/local/bin/corner-ops-gemini-phone

RUN chmod 0755 /usr/local/bin/corner-ops-asterisk-entrypoint /usr/local/bin/corner-ops-voice-payment /usr/local/bin/corner-ops-gemini-phone \
    && mkdir -p /usr/share/asterisk/sounds/en/voice-payment \
    && for spec in \
      'welcome:You are now on the secure automated payment line. Nothing you say here is sent to the ordering assistant or saved in a transcript.' \
      'card-number:Please slowly say the card number, in groups of four digits.' \
      'expiration:Say the two digit expiration month followed by the two digit year.' \
      'security-code:Say the three or four digit security code.' \
      'billing-zip:Say the five digit billing zip code.' \
      'confirm-ending:I heard a card ending in' \
      'confirm-yes:Say yes if that is correct, or no to try again.' \
      'try-again:I did not understand that. Please try again slowly.' \
      'processing:Please wait while I securely process the sandbox payment.' \
      'approved:Your test payment was approved and your order is complete. Thank you for calling Corner Deli.' \
      'employee-help:I could not complete the secure test payment. I will transfer you to an employee.'; do \
      name="$${spec%%:*}"; text="$${spec#*:}"; \
      espeak-ng -s 145 -w "/tmp/$${name}.wav" "$${text}"; \
      sox "/tmp/$${name}.wav" -r 8000 -c 1 -e signed-integer -b 16 "/usr/share/asterisk/sounds/en/voice-payment/$${name}.wav"; \
      rm "/tmp/$${name}.wav"; \
    done

ENTRYPOINT ["/usr/local/bin/corner-ops-asterisk-entrypoint"]
