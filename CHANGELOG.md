# Changelog

## 0.1.3

- Works with pi 1.6.0.

## Unreleased

- Show provider errors and empty model responses as failed runs in Slack instead of empty successful replies.

- Add `configsFromEnv()` and multi-bot CLI profiles via `PI_SLACK_WORKSPACES`, with isolated data directories and separate Slack apps.
- Allow all users with `PI_SLACK_ALLOWED_USERS=*`, including restart recovery, without sending DMs to the wildcard.
- Add opt-in Git branch auto-updates with pre-deployment checks, a systemd timer and process-health rollback.

## 0.1.2

- Works with pi 1.5.2.

## 0.1.1

- First release published from GitHub Actions (npm trusted publishing).

## 0.1.0

- First release: one pi session per Slack thread, mentions, direct messages and thread follow-ups, attachments, `slack_upload` tool, reactions, `!stop`, `!status`, `!model`, `!help`, resume after restart.
