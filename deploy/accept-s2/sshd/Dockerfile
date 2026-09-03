# syntax=docker/dockerfile:1.7
#
# accept-s2 sshd: a minimal, container-simulated "test SSH host" for scripts/accept_s2.sh (S2.12
# deliverable 1a "a test SSH host (container-simulated)"). Test fixture only — never part of a
# production deploy; this is the target the ssh-kind Gatekeeper (packages/gatekeeper-base's
# `main()`, GATE_TRANSPORT_KIND=ssh) connects out to, never reached directly by anything else (the
# accept-s2 gates are the only two services accept_s2.sh points at it).
#
# alpine + openssh-server: smallest reasonable sshd for a throwaway acceptance fixture. Pubkey-only
# auth (no password ever configured) — the private half of the keypair lives only in the ssh gate
# container (accept_s2.sh generates it at run time into ${NEXTTIME_DATA}/accept-s2/ssh/, never
# committed to the repo, per this task's "never hardcode secrets" rule); this image only ever
# receives the *public* half via a read-only bind mount (see entrypoint.sh).
#
# Build context is the repo root: docker build -f deploy/accept-s2/sshd/Dockerfile .

FROM alpine:3.20
RUN apk add --no-cache openssh-server \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh testuser \
 && mkdir -p /home/testuser/.ssh \
 && chown -R testuser:testuser /home/testuser/.ssh \
 && chmod 700 /home/testuser/.ssh

COPY --chmod=755 deploy/accept-s2/sshd/entrypoint.sh /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
