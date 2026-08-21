FROM ubuntu:24.04

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      asterisk \
      ca-certificates \
      gettext-base \
    && rm -rf /var/lib/apt/lists/*

COPY pjsip.conf.template /opt/corner-ops-asterisk/pjsip.conf.template
COPY extensions.conf.template /opt/corner-ops-asterisk/extensions.conf.template
COPY rtp.conf /etc/asterisk/rtp.conf
COPY entrypoint.sh /usr/local/bin/corner-ops-asterisk-entrypoint

RUN chmod 0755 /usr/local/bin/corner-ops-asterisk-entrypoint

ENTRYPOINT ["/usr/local/bin/corner-ops-asterisk-entrypoint"]
