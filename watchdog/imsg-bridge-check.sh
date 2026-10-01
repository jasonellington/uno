#!/bin/zsh
# Keeps the imsg Private API helper injected into Messages, and texts the
# owner when the gateway goes offline and comes back. Run by the
# ai.uno.imsg-bridge LaunchAgent at login and every 60 s. Never runs two
# `imsg launch` at once: concurrent launches can leave two injected Messages
# instances racing. So: check status, take a
# non-blocking lock, check status again under the lock, then launch.
export PATH=/opt/homebrew/bin:/usr/bin:/bin
LOCK=/tmp/ai.uno.imsg-bridge.lock
ready() { imsg status --json 2>/dev/null | grep -q '"v2_ready":true'; }

# Gateway watch: texts the owner "I'm offline" after two failed health
# checks in a row (about 2 minutes, so restarts stay quiet) and "I'm back
# online" once it recovers. The only offline/online texts. Sent with imsg, so it works while the
# gateway is down. The owner is the first phone number in the iMessage
# allowFrom list. State: "<fails> <notified>".
STATE=$HOME/.openclaw/uno-data/gateway-down
owner() { openclaw config get channels.imessage.allowFrom --json 2>/dev/null | grep -oE '"\+[0-9]+"' | head -1 | tr -d '"'; }
tell_owner() { local to=$(owner); [[ -n $to ]] && imsg send --to "$to" --text "$1" --service imessage >/dev/null 2>&1; }
gateway_watch() {
  local fails=0 notified=0
  [[ -f $STATE ]] && read fails notified < $STATE
  if perl -e 'alarm 20; exec @ARGV' openclaw health --json 2>/dev/null | grep -q '"ok": *true'; then
    if (( notified )) && tell_owner "Hey, I'm back online."; then echo "$(date -u +%FT%TZ) gateway back, told the owner"; fi
    fails=0; notified=0
  else
    (( fails++ ))
    if (( fails >= 2 && ! notified )) && tell_owner "Hey, I'm offline. I'll text you when I'm back."; then
      notified=1; echo "$(date -u +%FT%TZ) gateway down ${fails} checks, told the owner"
    fi
  fi
  echo "$fails $notified" > $STATE
}

if [[ "$1" != "--locked" ]]; then
  gateway_watch
  csrutil status | grep -q 'disabled' || exit 0
  ready && exit 0
  # -t 0: if another run holds the lock, skip this one instead of queueing.
  exec lockf -t 0 "$LOCK" "$0" --locked
fi

ready && exit 0
# --force: a plain launch can leave Messages running with a dead helper and
# never recover (Sept 27: 33 minutes of failed launches; --force fixed it at
# once). This only runs when the bridge is already down.
echo "$(date -u +%FT%TZ) bridge not ready, running imsg launch --force"
imsg launch --force
