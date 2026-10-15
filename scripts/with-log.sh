#!/usr/bin/env bash
#
# Request logs (spec D3, D4). Runs a command with its output shown as it always
# was, and also appended to $LANE_LOGS/<name>.log, so what the server or Metro
# printed can be read after the fact by Victor or by Claude:
#
#   bash scripts/with-log.sh [--tty] <name> <command...>
#
# Each line in the file starts with the local time to the millisecond. Colour
# codes are stripped from the file, and a line redrawn in place (a progress bar)
# keeps only its last state; the terminal gets the bytes untouched. stderr is
# merged into stdout, so both reach the file.
#
# --tty runs the command under `script`, which gives it a terminal of its own:
# Metro's keys and QR code need one, and a pipe would take it away. It applies
# only when this script's own stdin is a terminal.
#
# At start, a file over WITH_LOG_MAX_BYTES (50 MB) moves to <name>.log.1,
# replacing an older one. LANE_LOGS comes from lane-env.sh (ADR 0006 R5).

set -u

fail() { echo "with-log.sh: $1" >&2; exit 2; }

tty=0
if [ "${1:-}" = "--tty" ]; then tty=1; shift; fi
name="${1:-}"
[ $# -ge 2 ] || fail "usage: with-log.sh [--tty] <name> <command...>"
shift
case "$name" in
  ''|*[!a-z0-9_-]*) fail "the log name '$name' must be lower-case letters, digits, - or _" ;;
esac
[ -n "${LANE_LOGS:-}" ] || fail "LANE_LOGS is not set; run this through scripts/lane-env.sh"

mkdir -p "$LANE_LOGS" || fail "cannot create $LANE_LOGS"
file="$LANE_LOGS/$name.log"
max="${WITH_LOG_MAX_BYTES:-52428800}"
if [ -f "$file" ] && [ "$(wc -c < "$file")" -gt "$max" ]; then
  mv -f "$file" "$file.1"
fi

# The file side of the tee: every chunk goes to the terminal at once, and each
# complete line to the file, stamped and cleaned. INT is ignored so a Ctrl-C
# stops the command, not the logging of its shutdown; EOF ends this.
stamp() {
  perl -e '
    use strict; use warnings; use POSIX qw(strftime); use Time::HiRes qw(time);
    $SIG{INT} = "IGNORE";
    open(my $f, ">>", $ARGV[0]) or die "with-log.sh: cannot write $ARGV[0]: $!\n";
    $f->autoflush(1);
    sub now { my $t = time; strftime("%Y-%m-%d %H:%M:%S", localtime $t) . sprintf(".%03d", ($t - int $t) * 1000) }
    sub line {
      my $l = shift;
      $l =~ s/\e\[[0-9;?]*[ -\/]*[@-~]//g;   # CSI: colours, cursor moves
      $l =~ s/\e\][^\a\e]*(?:\a|\e\\)//g;    # OSC: titles, links
      $l =~ s/\e[@-_]//g;                     # any other escape
      $l =~ s/\x04[\x08]*//g;                 # script echoing an EOF from a closed stdin
      $l =~ s/^.*\r(?=[^\r])//s;              # a redrawn line: its last state
      $l =~ s/\r//g;
      print $f now() . " $l\n" if $l =~ /\S/;
    }
    print $f now() . " $ARGV[1]\n";
    my $buf = "";
    while (sysread(STDIN, my $chunk, 65536)) {
      syswrite(STDOUT, $chunk);
      $buf .= $chunk;
      line($1) while $buf =~ s/^([^\n]*)\n//;
    }
    line($buf) if length $buf;
  ' "$file" "$1"
}

started="---- $name started $(date '+%Y-%m-%d %H:%M:%S') (${APP_COMMIT:-unknown})"

if [ "$tty" -eq 1 ] && [ -t 0 ]; then
  if [ "$(uname)" = "Darwin" ]; then
    script -q /dev/null "$@" | stamp "$started"
  else
    script -qefc "$(printf '%q ' "$@")" /dev/null | stamp "$started"
  fi
else
  "$@" 2>&1 | stamp "$started"
fi
exit "${PIPESTATUS[0]}"
