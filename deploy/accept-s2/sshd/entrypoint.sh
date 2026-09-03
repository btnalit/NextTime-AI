#!/bin/sh
# accept-s2 sshd entrypoint: copies the bind-mounted public key (read-only,
# /etc/accept-s2/authorized_keys — see docker-compose.yml's accept-s2-sshd service) into
# testuser's authorized_keys with the permissions sshd insists on (world/group-readable
# authorized_keys or a group-writable .ssh dir make sshd silently refuse pubkey auth), then runs
# sshd in the foreground. Runs as root (sshd itself needs it to drop privileges per session,
# read-only rootfs is not applied to this throwaway test fixture — see docker-compose.yml's own
# comment on this service).

set -eu

AUTHORIZED_KEYS_SRC=/etc/accept-s2/authorized_keys
AUTHORIZED_KEYS_DST=/home/testuser/.ssh/authorized_keys

if [ ! -f "$AUTHORIZED_KEYS_SRC" ]; then
  echo "accept-s2-sshd: $AUTHORIZED_KEYS_SRC not mounted — nothing to authenticate with" >&2
  exit 1
fi

cp "$AUTHORIZED_KEYS_SRC" "$AUTHORIZED_KEYS_DST"
chown testuser:testuser "$AUTHORIZED_KEYS_DST"
chmod 600 "$AUTHORIZED_KEYS_DST"

exec /usr/sbin/sshd -D -e \
  -o PasswordAuthentication=no \
  -o PermitRootLogin=no \
  -o PubkeyAuthentication=yes \
  -o UsePAM=no
