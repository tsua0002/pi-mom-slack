#!/usr/bin/env bash
# Installed by install-auto-update.sh. Never source the bot's .env in a shell.
set -euo pipefail
umask 077
state=$HOME/.local/share/pi-mom-slack-updates
exec 9>"$state/lock"
flock -n 9 || exit 0
source "$state/config"
export PATH
export GIT_TERMINAL_PROMPT=0
unit=pi-mom-slack.service
drop=$HOME/.config/systemd/user/$unit.d/90-auto-update.conf
mkdir -p "$state/releases" "$(dirname "$drop")"
if [[ ! -d $state/repo.git ]]; then
  git init --bare "$state/repo.git"
fi
git --git-dir="$state/repo.git" -c credential.helper= fetch --no-tags "$repo" "+refs/heads/$branch:refs/heads/update"
commit=$(git --git-dir="$state/repo.git" rev-parse refs/heads/update)
if [[ -f $state/current && $(<"$state/current") == "$commit" ]]; then
  exit 0
fi
release=$state/releases/$commit
# A failed/interrupted preparation must never be mistaken for a checked release.
if [[ ! -f $release/.update-ready ]]; then
  rm -rf -- "$release"
  mkdir -p "$release"
  git --git-dir="$state/repo.git" archive "$commit" | tar -x -C "$release"
  (
    cd "$release"
    npm ci --include=dev --no-audit --no-fund
    npm run build
    npm run check
    npm test
  )
  touch "$release/.update-ready"
fi
# Save the previous override, including the absence of one on the first update.
had_drop=false
if [[ -f $drop ]]; then cp "$drop" "$state/previous-override"; had_drop=true; fi
switching=false
rollback() {
  local rc=$?
  trap - EXIT INT TERM
  if $switching; then
    echo 'Update failed; restoring previous service configuration.' >&2
    if $had_drop; then
      cp "$state/previous-override" "$drop.tmp"
      mv "$drop.tmp" "$drop"
    else
      rm -f "$drop"
    fi
    systemctl --user daemon-reload
    systemctl --user reset-failed "$unit" || true
    systemctl --user restart "$unit" || true
  fi
  exit "$rc"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
switching=true
# Installer restricts paths to characters safe in systemd directives.
printf '[Service]\nWorkingDirectory=%s\nEnvironment=PI_SLACK_ENV_FILE=%s/.env\n' "$release" "$app" > "$drop.tmp"
mv "$drop.tmp" "$drop"
systemctl --user daemon-reload
systemctl --user reset-failed "$unit" || true
systemctl --user restart "$unit"
# Require the same process to remain active through a short observation window.
pid=$(systemctl --user show "$unit" -p MainPID --value)
[[ $pid != 0 ]]
for ((i=0; i<15; i++)); do
  sleep 1
  systemctl --user is-active --quiet "$unit"
  [[ $(systemctl --user show "$unit" -p MainPID --value) == "$pid" ]]
done
printf '%s\n' "$commit" > "$state/current.tmp"
mv "$state/current.tmp" "$state/current"
switching=false
echo "Activated $commit"
