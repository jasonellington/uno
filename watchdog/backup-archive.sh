#!/bin/zsh
# Weekly full OpenClaw archive (config, credentials, sessions, workspace) into
# ~/Backups/archives, verified. Keeps the newest 8; older ones go to the Trash
# (never deleted outright). Run by the OpenClaw command job uno-backup-archive.
export PATH=/opt/homebrew/bin:/usr/bin:/bin
DIR=$HOME/Backups/archives
mkdir -p "$DIR"
openclaw backup create --output "$DIR" --verify >/dev/null || exit 1
ls -t "$DIR"/*-openclaw-backup.tar.gz 2>/dev/null | tail -n +9 | while read -r f; do mv "$f" "$HOME/.Trash/"; done
echo "archives: $(ls "$DIR"/*-openclaw-backup.tar.gz | wc -l | tr -d ' ')"
