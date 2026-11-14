# A throwaway Debian for testing deploy/ without a Raspberry Pi. See run.sh.
#
# Deliberately NOT a systemd container: it runs unprivileged, with a small
# stand-in for systemctl. Never run this (or anything else) with --privileged
# and an init system on a desktop machine: a privileged systemd container can
# take over the host's display and input devices and end the login session.
ARG BASE=debian:12
FROM ${BASE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates \
      util-linux iproute2 procps curl passwd \
 && rm -rf /var/lib/apt/lists/*
COPY fake-systemctl /usr/local/bin/systemctl
COPY fake-journalctl /usr/local/bin/journalctl
RUN chmod 755 /usr/local/bin/systemctl /usr/local/bin/journalctl
