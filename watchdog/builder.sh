#!/bin/zsh
# The builder: runs the owner's coding agent headless, on one task, in its own
# worktree of the Uno repo, with the brief in builder-brief.md. Admin Uno
# starts it (owner skill fix-myself), only after the owner's 👍 on the task
# (uno-guard). It detaches at once, so the gateway restart it may cause
# doesn't stop it, and when it's done it sends its report into the owner's
# chat, where Uno passes it on. Which agent runs is private:
# ~/.openclaw/uno-data/builder.env sets BUILDER_CMD (the command, taking the
# task as its last argument), BUILDER_CONTINUE (the flags that continue the
# last conversation in the same folder, for follow-ups), BUILDER_BRIEF (the
# flag that takes the brief's text) and BUILDER_REPORT_TO (the chat's
# session key).
# Usage: builder.sh <short-name> <task…>   (same name again = a follow-up)
#        builder.sh done <short-name>      (removes its worktree and branch)
set -u
repo=$HOME/uno
here=${0:A:h}
if [[ ${1:-} == done ]]; then
  name=${2:-}; [[ $name =~ '^[a-z0-9][a-z0-9-]{0,39}$' ]] || { echo "builder: which short name?"; exit 2; }
  git -C $repo worktree remove $repo/.claude/worktrees/fix-$name && git -C $repo branch -D fix/$name && echo "builder: $name cleaned up"
  exit $?
fi
name=${1:-}; shift 2>/dev/null; task="$*"
[[ $name =~ '^[a-z0-9][a-z0-9-]{0,39}$' ]] || { echo "builder: name must be lowercase letters, digits and dashes"; exit 2; }
[[ -n ${task// /} ]] || { echo "builder: no task"; exit 2; }
env_file=$HOME/.openclaw/uno-data/builder.env
[[ -r $env_file ]] || { echo "builder: not set up ($env_file is missing)"; exit 2; }
BUILDER_CMD=(); BUILDER_CONTINUE=(); BUILDER_BRIEF=(); BUILDER_REPORT_TO=""
source $env_file
(( ${#BUILDER_CMD} )) || { echo "builder: BUILDER_CMD is empty"; exit 2; }
logs=$HOME/.openclaw/uno-data/builder; mkdir -p $logs && chmod 700 $logs

# Detach: a new session, so stopping the gateway (and everything it started)
# leaves the builder running.
if [[ -z ${BUILDER_DETACHED:-} ]]; then
  BUILDER_DETACHED=1 nohup /usr/bin/python3 -c 'import os, sys; os.setsid(); os.execv(sys.argv[1], sys.argv[1:])' /bin/zsh "$0" "$name" "$task" > /dev/null 2>> $logs/$name.err &
  echo "builder $name started; it reports back in the owner's chat when it's done (log: $logs/$name.out)"
  exit 0
fi

wt=$repo/.claude/worktrees/fix-$name
again=()
if [[ -d $wt ]]; then again=("${BUILDER_CONTINUE[@]}")
else git -C $repo worktree add -q $wt -b fix/$name master 2>> $logs/$name.err || { echo "builder: couldn't make the worktree" >> $logs/$name.err; exit 3; }
fi
cd $wt || exit 3
brief=()
(( ${#BUILDER_BRIEF} )) && brief=("${BUILDER_BRIEF[@]}" "$(< $here/builder-brief.md)")
"${BUILDER_CMD[@]}" "${brief[@]}" "${again[@]}" "$task" > $logs/$name.last 2>> $logs/$name.err
code=$?
cat $logs/$name.last >> $logs/$name.out

# Report into the owner's chat; the gateway may still be restarting.
[[ -n $BUILDER_REPORT_TO ]] || exit $code
report=$logs/$name.report
{
  print -r -- "[The builder's report on \"$name\", not from the owner; it finished with exit $code. Check that what it says is live, then tell the owner in two lines what was wrong and what changed, with the before and after scores, and ask any question it left.]"
  print
  if [[ -s $logs/$name.last ]]; then tail -c 3000 $logs/$name.last; else print "(It wrote no report. Its log: $logs/$name.out and $name.err.)"; fi
} > $report
for i in {1..30}; do
  openclaw agent --agent main --session-key "$BUILDER_REPORT_TO" --message-file $report --deliver > /dev/null 2>> $logs/$name.err && exit $code
  sleep 20
done
exit $code
