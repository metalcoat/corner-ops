#!/bin/sh
set -eu

: "${ASTERISK_3CX_IP:?ASTERISK_3CX_IP is required}"
: "${ASTERISK_OPENAI_PROJECT_ID:?ASTERISK_OPENAI_PROJECT_ID is required}"
: "${ASTERISK_OPENAI_DID:?ASTERISK_OPENAI_DID is required}"
: "${ASTERISK_VOICE_PAYMENT_EXTENSION:=101}"
: "${ASTERISK_VOICE_PAYMENT_FALLBACK_EXTENSION:=95}"
: "${VOICE_PAYMENT_API_URL:=http://127.0.0.1:3000/api/internal/voice-payment}"
: "${VOICE_PAYMENT_INTERNAL_SECRET:?VOICE_PAYMENT_INTERNAL_SECRET is required}"
: "${GEMINI_PHONE_APP_URL:=http://127.0.0.1:3000}"

case "$ASTERISK_3CX_IP" in
  *[!0-9.]*|'')
    echo "ASTERISK_3CX_IP must be an IPv4 address" >&2
    exit 64
    ;;
esac

case "$ASTERISK_OPENAI_PROJECT_ID" in
  proj_[A-Za-z0-9_-]*) ;;
  *)
    echo "ASTERISK_OPENAI_PROJECT_ID must start with proj_" >&2
    exit 64
    ;;
esac

envsubst '${ASTERISK_3CX_IP} ${ASTERISK_OPENAI_PROJECT_ID}' \
  < /opt/corner-ops-asterisk/pjsip.conf.template \
  > /etc/asterisk/pjsip.conf

envsubst '${ASTERISK_OPENAI_DID} ${ASTERISK_OPENAI_PROJECT_ID} ${ASTERISK_VOICE_PAYMENT_EXTENSION} ${ASTERISK_VOICE_PAYMENT_FALLBACK_EXTENSION}' \
  < /opt/corner-ops-asterisk/extensions.conf.template \
  > /etc/asterisk/extensions.conf

# Card-digit second opinion (local only, never logs requests). The card line falls back to Vosk alone if it's off.
if [ "${VOICE_PAYMENT_SECOND_OPINION:-false}" = "true" ] && [ -x /opt/llama/llama-server ]; then
  LD_LIBRARY_PATH=/opt/llama /opt/llama/llama-server -m /opt/card-asr/model.gguf --mmproj /opt/card-asr/mmproj.gguf \
    -t "${VOICE_PAYMENT_SECOND_OPINION_THREADS:-4}" -c 2048 --host 127.0.0.1 --port 18090 --log-disable >/dev/null 2>&1 &
fi

if [ "${GEMINI_PHONE_BRIDGE_ENABLED:-false}" = "true" ] && [ -n "${GEMINI_API_KEY:-}" ]; then
  /usr/local/bin/corner-ops-gemini-phone &
fi

exec /usr/sbin/asterisk -f -U asterisk -G asterisk -vvv
