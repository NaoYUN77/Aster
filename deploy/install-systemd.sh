#!/usr/bin/env bash
# Install the personal agent as a systemd service on Linux.
#
# Usage:
#   sudo ./deploy/install-systemd.sh
#
# Re-running is safe: files are replaced, the data directory is kept.
# Read deploy/README-systemd.md first if you need non-default paths.
set -euo pipefail

APP_DIR=/opt/personal-agent
DATA_DIR=/var/lib/personal-agent
ENV_FILE=/etc/personal-agent.env
SERVICE_USER=personal-agent
UNIT_FILE=/etc/systemd/system/personal-agent.service
NODE_BIN=${NODE_BIN:-$(command -v node || true)}

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo $0)"
[[ -n "$NODE_BIN" ]] || die "node not found; install Node.js 24.19.0 and re-run with NODE_BIN=/path/to/node"
[[ -x "$NODE_BIN" ]] || die "NODE_BIN is not executable: $NODE_BIN"
node_version=$("$NODE_BIN" --version)
[[ "$node_version" =~ ^v24\. ]] || die "Node.js 24.x required, found $node_version"
# ProtectHome=true hides /home, /root and /run/user, so a Node installed there is not visible to the service.
case "$NODE_BIN" in
  /home/*|/root/*|/run/user/*)
    die "Node is installed under a home directory and hidden by ProtectHome=true; install a system-wide Node.js"
    ;;
esac
[[ -f package.json && -f deploy/personal-agent.service ]] || die "run from the repository root"
command -v flock >/dev/null || die "flock not found; install util-linux"
command -v runuser >/dev/null || die "runuser not found; install util-linux"
command -v bash >/dev/null || die "bash not found; the bash tool requires it"
command -v npm >/dev/null || die "npm not found; install it alongside Node.js"

# Copying the tree onto itself would corrupt the source checkout.
[[ "$(realpath .)" != "$(realpath -m "$APP_DIR")" ]] || die "run from a checkout outside $APP_DIR"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "creating system user $SERVICE_USER"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

log "creating directories"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$APP_DIR" "$DATA_DIR"

log "installing application files"
# Keep data and configuration out of the code directory.
tar -cf - --exclude=.git --exclude=node_modules --exclude=dist --exclude=data --exclude=.env . \
  | tar -xf - -C "$APP_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
# tar preserves the checkout's modes, which need not be restrictive; only the service user writes code.
chmod 755 "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  log "creating $ENV_FILE from .env.example (fill in the values)"
  install -o root -g root -m 600 .env.example "$ENV_FILE"
  sed -i "s#^DATA_DIR=.*#DATA_DIR=$DATA_DIR#" "$ENV_FILE"
fi

# Validate before the expensive build, and again before systemd is touched: an unusable config
# would otherwise leave the unit in a restart loop. Trailing whitespace is tolerated because the
# application trims environment values.
validate_config() {
  grep -qE "^DATA_DIR=${DATA_DIR}[[:space:]]*\$" "$ENV_FILE" \
    || die "$ENV_FILE must set DATA_DIR=$DATA_DIR to match ReadWritePaths"
  # Only the configured provider's key is required; the other one stays empty on purpose.
  provider=$(sed -n 's/^MODEL_PROVIDER=//p' "$ENV_FILE" | tail -n 1)
  provider=${provider//[[:space:]]/}
  case "$provider" in
    anthropic) API_KEY=ANTHROPIC_API_KEY ;;
    openai) API_KEY=OPENAI_API_KEY ;;
    *) die "$ENV_FILE must set MODEL_PROVIDER to anthropic or openai" ;;
  esac
  # Succeeds only when no placeholder credential remains; an empty value would restart-loop the unit.
  ! grep -qE "^(TELEGRAM_BOT_TOKEN|TELEGRAM_OWNER_ID|MODEL_ID|${API_KEY})=[[:space:]]*\$" "$ENV_FILE"
}
if validate_config; then configured=true; else configured=false; fi

log "installing dependencies and building"
# Build as the service user with a writable HOME and npm cache: runuser keeps root's HOME otherwise.
rm -rf "$APP_DIR/dist"
runuser -u "$SERVICE_USER" -- env HOME="$APP_DIR" npm_config_cache="$APP_DIR/.npm" \
  bash -c "cd '$APP_DIR' && npm ci && npm run build && npm prune --omit=dev"
rm -rf "$APP_DIR/.npm"

log "installing systemd unit"
# Substitute the real paths into the checked-in template.
escaped_node=${NODE_BIN//&/\\&}
escaped_flock=$(command -v flock)
escaped_flock=${escaped_flock//&/\\&}
escaped_app=${APP_DIR//&/\\&}
escaped_data=${DATA_DIR//&/\\&}
sed -e "s#/usr/bin/flock#${escaped_flock}#" \
    -e "s#/usr/bin/node#${escaped_node}#" \
    -e "s#/opt/personal-agent#${escaped_app}#g" \
    -e "s#/var/lib/personal-agent#${escaped_data}#g" \
  deploy/personal-agent.service > "$UNIT_FILE"
chmod 644 "$UNIT_FILE"

if validate_config; then configured=true; else configured=false; fi

log "enabling service"
systemctl daemon-reload
systemctl enable personal-agent

if [[ "$configured" == false ]]; then
  log "configuration still has empty values; edit $ENV_FILE, then run: systemctl start personal-agent"
  exit 0
fi

log "starting service"
systemctl restart personal-agent
sleep 2
systemctl --no-pager --lines=10 status personal-agent || true
log "done. follow logs with: journalctl -u personal-agent -f"
