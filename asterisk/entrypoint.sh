#!/bin/sh
set -eu

: "${ASTERISK_3CX_IP:?ASTERISK_3CX_IP is required}"
: "${ASTERISK_OPENAI_PROJECT_ID:?ASTERISK_OPENAI_PROJECT_ID is required}"
: "${ASTERISK_OPENAI_DID:?ASTERISK_OPENAI_DID is required}"

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

envsubst '${ASTERISK_OPENAI_DID} ${ASTERISK_OPENAI_PROJECT_ID}' \
  < /opt/corner-ops-asterisk/extensions.conf.template \
  > /etc/asterisk/extensions.conf

exec /usr/sbin/asterisk -f -U asterisk -G asterisk -vvv
