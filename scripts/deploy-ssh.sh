#!/usr/bin/env bash
# Installs pi-mom-slack on a server over SSH and runs it as a user systemd service.
# Run it from your clone of this repository, next to the bot's .env:
#
#   scripts/deploy-ssh.sh <ssh-host> [remote-dir]      (remote-dir defaults to pi-mom-slack, under the remote home)
#
# The code sent is the current commit of this clone (git archive), so the server needs no GitHub access.
# The server needs Node.js 22.19+ and pi already logged in (~/.pi/agent). Run it again to update.
set -euo pipefail

host=${1:?usage: scripts/deploy-ssh.sh <ssh-host> [remote-dir]}
dir=${2:-pi-mom-slack}
test -f .env || { echo "No .env here: create it first (see the README)." >&2; exit 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "Run this from your clone of pi-mom-slack." >&2; exit 1; }
commit=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain --untracked-files=no)" ] || echo "note: uncommitted changes are not sent, only commit $commit" >&2

echo "==> $host: checking Node and pi"
ssh "$host" bash -ls <<'REMOTE'
set -euo pipefail
# Non-interactive SSH sessions skip nvm/volta/fnm setup: find node the way an interactive shell would.
find_node() {
  local d
  # Newest nvm or fnm install first (sorting by version), then the usual places, then whatever the profile set.
  for d in $(ls -d "$HOME"/.nvm/versions/node/v*/bin "$HOME"/.local/share/fnm/node-versions/v*/installation/bin 2>/dev/null | sort -rV) \
           "$HOME/.volta/bin" "$HOME/.local/bin" /usr/local/bin /opt/homebrew/bin; do
    if [ -x "$d/node" ] && "$d/node" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)'; then
      export PATH="$d:$PATH"; return 0
    fi
  done
  command -v node >/dev/null 2>&1
}
find_node || { echo "Node.js not found on the server, even next to pi ($(command -v pi || echo 'pi not in PATH')). Install Node 22.19+ (e.g. nvm install 22) and run again." >&2; exit 1; }
echo "node $(node -v) at $(command -v node)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || { echo "Node.js $(node -v) is too old: 22.19 or later is needed" >&2; exit 1; }
test -d ~/.pi/agent || echo "warning: ~/.pi/agent not found: run pi once on the server and log in" >&2
# Without linger, systemd stops user services when the last SSH session closes: the bot would die with this script.
loginctl enable-linger "$(id -un)" 2>/dev/null || true
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
  echo "ERROR: linger is off for $(id -un): the bot stops as soon as you log out." >&2
  echo "Run once: ssh <host> sudo loginctl enable-linger $(id -un)   then run this script again." >&2
  exit 1
fi
REMOTE

echo "==> $host: sending commit $commit to ~/$dir and building (a slow server can take a few minutes)"
# shellcheck disable=SC2029 # expanded locally on purpose
git archive --format=tar HEAD | ssh "$host" "mkdir -p '$dir' && tar -x -C '$dir'"
ssh "$host" bash -ls -- "$dir" <<'REMOTE'
set -euo pipefail
dir=$1
# Non-interactive SSH sessions skip nvm/volta/fnm setup: find node the way an interactive shell would.
find_node() {
  local d
  # Newest nvm or fnm install first (sorting by version), then the usual places, then whatever the profile set.
  for d in $(ls -d "$HOME"/.nvm/versions/node/v*/bin "$HOME"/.local/share/fnm/node-versions/v*/installation/bin 2>/dev/null | sort -rV) \
           "$HOME/.volta/bin" "$HOME/.local/bin" /usr/local/bin /opt/homebrew/bin; do
    if [ -x "$d/node" ] && "$d/node" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)'; then
      export PATH="$d:$PATH"; return 0
    fi
  done
  command -v node >/dev/null 2>&1
}
find_node
cd ~/"$dir"
npm ci --no-audit --no-fund
npm run build
REMOTE

echo "==> $host: copying .env (mode 600)"
scp -q .env "$host:$dir/.env"
# shellcheck disable=SC2029 # expanded locally on purpose
ssh "$host" chmod 600 "$dir/.env"

echo "==> $host: installing and (re)starting the pi-mom-slack service"
ssh "$host" bash -ls -- "$dir" <<'REMOTE'
set -euo pipefail
dir=$1
# Non-interactive SSH sessions skip nvm/volta/fnm setup: find node the way an interactive shell would.
find_node() {
  local d
  # Newest nvm or fnm install first (sorting by version), then the usual places, then whatever the profile set.
  for d in $(ls -d "$HOME"/.nvm/versions/node/v*/bin "$HOME"/.local/share/fnm/node-versions/v*/installation/bin 2>/dev/null | sort -rV) \
           "$HOME/.volta/bin" "$HOME/.local/bin" /usr/local/bin /opt/homebrew/bin; do
    if [ -x "$d/node" ] && "$d/node" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)'; then
      export PATH="$d:$PATH"; return 0
    fi
  done
  command -v node >/dev/null 2>&1
}
find_node
node=$(command -v node)
unit=~/.config/systemd/user/pi-mom-slack.service
mkdir -p "$(dirname "$unit")"
cat > "$unit" <<UNIT
[Unit]
Description=pi-mom-slack (pi in Slack)
After=network-online.target

[Service]
WorkingDirectory=$HOME/$dir
Environment=PATH=$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
ExecStart=$node dist/cli.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable pi-mom-slack >/dev/null 2>&1
systemctl --user restart pi-mom-slack
# Keep the service running after logout; may need sudo on some systems.

sleep 5
systemctl --user --no-pager --lines=15 status pi-mom-slack || true
REMOTE

echo
echo "Done. Logs: ssh $host journalctl --user -u pi-mom-slack -f"
echo "Stop any other copy of the bot using the same Slack app (Slack splits events between them)."
