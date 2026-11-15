#!/usr/bin/env bash
# Run on the service host, as the service's user (not root).
set -euo pipefail
umask 077
[[ $# == 3 ]] || { echo "Usage: $0 <public-https-repo-url> <branch> <existing-app-dir>" >&2; exit 1; }
repo=$1 branch=$2
app=$(realpath "$3")
state=$HOME/.local/share/pi-mom-slack-updates
unitdir=$HOME/.config/systemd/user
for command in git node npm flock systemctl realpath; do command -v "$command" >/dev/null; done
[[ $repo =~ ^https://[A-Za-z0-9.-]+/[A-Za-z0-9._/-]+$ ]] || { echo 'Use a public HTTPS URL without credentials or query parameters.' >&2; exit 1; }
git check-ref-format "refs/heads/$branch"
# Keep generated systemd directives unambiguous (no specifiers or shell escaping).
for path in "$app" "$HOME" "$(command -v node)" "$PATH"; do
  [[ $path =~ ^[A-Za-z0-9_./:+-]+$ ]] || { echo 'Paths must not contain whitespace, percent signs or quoting characters.' >&2; exit 1; }
done
[[ -f $app/.env && -f $app/dist/cli.js ]]
systemctl --user is-active --quiet pi-mom-slack.service
[[ $(systemctl --user show pi-mom-slack.service -p WorkingDirectory --value) == "$app" || -f $state/config ]] || {
  echo 'Existing service WorkingDirectory does not match the app directory.' >&2; exit 1;
}
# Only support the archive service's relative entrypoint; never silently run old code.
execstart=$(systemctl --user show pi-mom-slack.service -p ExecStart --value)
[[ $execstart == *' dist/cli.js ;'* ]] || { echo 'Expected service ExecStart: <node> dist/cli.js' >&2; exit 1; }
# Relative data paths would move with WorkingDirectory. Inspect both configuration sources.
service_env=$(systemctl --user show pi-mom-slack.service -p Environment --value)
SERVICE_ENV="$service_env" node --input-type=module - "$app/.env" <<'JS'
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { isAbsolute } from 'node:path';
const env = parseEnv(readFileSync(process.argv[2], 'utf8'));
const filePath = env.PI_SLACK_DATA_DIR?.trim();
const values = [filePath];
const service = process.env.SERVICE_ENV;
for (const match of service.matchAll(/PI_SLACK_DATA_DIR=([^\s"]+)/g)) values.push(match[1]);
if (values.some(value => value && !isAbsolute(value))) {
  console.error('Convert PI_SLACK_DATA_DIR to its existing absolute path before installing.');
  process.exit(1);
}
JS
[[ -z $(systemctl --user show pi-mom-slack.service -p EnvironmentFiles --value) ]] || {
  echo 'EnvironmentFile directives require manual review; use the app .env instead.' >&2; exit 1;
}
mkdir -p "$state" "$unitdir"
exec 9>"$state/lock"
flock -n 9 || { echo 'Updater is running; retry later.' >&2; exit 1; }
install -m 700 "$(dirname "$0")/auto-update.sh" "$state/auto-update.sh"
printf 'repo=%q\nbranch=%q\napp=%q\nPATH=%q\n' "$repo" "$branch" "$app" "$PATH" > "$state/config"
cat > "$unitdir/pi-mom-slack-update.service" <<UNIT
[Unit]
Description=Check and stage pi-mom-slack updates
[Service]
Type=oneshot
ExecStart=/bin/bash $state/auto-update.sh
TimeoutStartSec=30min
UNIT
cat > "$unitdir/pi-mom-slack-update.timer" <<'UNIT'
[Unit]
Description=Poll pi-mom-slack Git branch every two minutes
[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min
[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now pi-mom-slack-update.timer
echo 'Installed. First check in two minutes; journalctl --user -u pi-mom-slack-update -f'
