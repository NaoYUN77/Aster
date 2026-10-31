#!/usr/bin/env bash
# Operator bootstrap for the OpenBao + MITM stack. Run on the server from deploy/openbao-mitm after
# `docker compose up -d openbao` and after OpenBao is initialized and unsealed. See README.md.
#
# Idempotent: enabling KV, writing the policy, and keeping an existing token file are all safe to repeat.
# Prompts for the root token and for each secret value with hidden input. Values are never printed,
# and they reach OpenBao on stdin, not in argv.
#
# usage: ASTER_OPENBAO_SECRETS=$HOME/Aster/secrets/openbao ./bootstrap.sh [NAME ...]
#   NAME is an env-style name such as DEEPSEEK_API_KEY; it is stored at secret/aster/NAME, field `value`.
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,11p' "$0"
  exit 0
fi

SECRETS_DIR="${ASTER_OPENBAO_SECRETS:-$HOME/Aster/secrets/openbao}"
CONTAINER="aster-openbao"
POLICY_NAME="aster-mitm-read"
TOKEN_FILE="$SECRETS_DIR/openbao-mitm-token"
MITM_CONFDIR="$SECRETS_DIR/mitmproxy"
EXPORTED_CA_CERT="$SECRETS_DIR/mitmproxy-ca.pem"

for name in "$@"; do
  if [[ ! "$name" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
    echo "invalid secret name: $name (expected ENV-style, e.g. DEEPSEEK_API_KEY)" >&2
    exit 2
  fi
done

read -rsp "OpenBao root token (hidden): " ROOT_TOKEN
echo

# Each call runs as the root token only for this step. The token goes through the container's environment.
bao() {
  docker exec -i -e BAO_TOKEN="$ROOT_TOKEN" "$CONTAINER" bao "$@"
}

if ! bao secrets list | grep -q '^secret/'; then
  bao secrets enable -path=secret -version=2 kv
  echo "enabled KV v2 at secret/"
else
  echo "KV at secret/ already enabled"
fi

printf '%s\n' 'path "secret/data/aster/*" { capabilities = ["read"] }' | bao policy write "$POLICY_NAME" - >/dev/null
echo "wrote policy $POLICY_NAME (read on secret/data/aster/* only)"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
if [[ -s "$TOKEN_FILE" ]]; then
  echo "kept existing token file (rotate by deleting it and rerunning)"
else
  (umask 077 && bao token create -policy="$POLICY_NAME" -orphan -period=720h -display-name=aster-mitm -field=token > "$TOKEN_FILE")
  chmod 600 "$TOKEN_FILE"
  echo "wrote read-only token file"
fi

for name in "$@"; do
  read -rsp "value for $name (hidden): " value
  echo
  printf '%s' "$value" | bao kv put "secret/aster/$name" value=- >/dev/null
  unset value
  echo "stored secret/aster/$name"
done

unset ROOT_TOKEN

mkdir -p "$MITM_CONFDIR"
if [[ -s "$MITM_CONFDIR/mitmproxy-ca-cert.pem" ]]; then
  cp "$MITM_CONFDIR/mitmproxy-ca-cert.pem" "$EXPORTED_CA_CERT"
  chmod 644 "$EXPORTED_CA_CERT"
  echo "exported public MITM CA certificate (no private key) to: $EXPORTED_CA_CERT"
elif [[ -s "$EXPORTED_CA_CERT" ]]; then
  echo "public MITM CA certificate present at: $EXPORTED_CA_CERT"
else
  echo "MITM CA not generated yet: start the mitm service once, then copy $MITM_CONFDIR/mitmproxy-ca-cert.pem to $EXPORTED_CA_CERT"
fi
