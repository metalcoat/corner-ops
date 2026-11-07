# 3CX to OpenAI SIP through Asterisk

3CX cannot validate the wildcard certificate currently served by the OpenAI SIP endpoint. The local Asterisk service terminates a LAN SIP leg from 3CX and creates a separate TLS/SRTP leg to OpenAI.

## Local environment

Set these values in `/opt/corner-ops/.env`:

```env
ASTERISK_3CX_IP="192.168.1.46"
ASTERISK_OPENAI_PROJECT_ID="proj_REPLACE_ME"
ASTERISK_OPENAI_DID="+13156057291"
```

The project ID must be the same OpenAI project that owns the Realtime incoming-call webhook and API key.

## 3CX trunk

Create a generic, IP-based trunk without registration:

- Registrar/server: `192.168.1.237`
- Port: `5060`
- Transport: UDP
- SRTP: disabled for the LAN leg
- Codec priority: PCMU, then PCMA

Keep the existing outbound rule that sends dialed extension `100` through this trunk. Do not rewrite the request user to the OpenAI project ID; Asterisk performs that rewrite.

The intermediary accepts SIP only from the configured 3CX IP and listens on the LAN host address. Its OpenAI leg verifies the normal CA chain and explicitly permits standards-compliant wildcard certificates. OpenAI media uses SDES-SRTP.

## Verification

```bash
docker exec corner-ops-asterisk asterisk -rx 'pjsip show transports'
docker exec corner-ops-asterisk asterisk -rx 'pjsip show endpoints'
docker exec corner-ops-asterisk asterisk -rx 'pjsip set logger on'
docker logs -f corner-ops-asterisk
```

Successful outbound signaling contains a request URI shaped like:

```text
sip:proj_...@sip.api.openai.com:5061;transport=tls
```
