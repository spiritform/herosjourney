#!/bin/sh
# Hero's Journey - start the local server.
#   ./start.sh          serve on 8800 and open the page
#   ./start.sh noopen   serve without opening a browser
#   PORT=8801 ./start.sh
#
# The twin of start.bat, and it makes the same three failures say what they
# are: an old node, a port already taken, and no key yet. Those are the ones
# that otherwise read as a Comfy problem.

cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8800}"

# NODE 22 IS NOT OPTIONAL. server.js uses global fetch and FormData, and on
# anything older it dies with "fetch is not defined" halfway through a run
# rather than at boot.
if ! command -v node >/dev/null 2>&1; then
  printf '\n  node is not on PATH. Install Node 22 or newer.\n\n'
  exit 1
fi
MAJ=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJ" -lt 22 ]; then
  printf '\n  node %s is too old - server.js needs 22 or newer for global fetch.\n\n' "$MAJ"
  exit 1
fi

# A SECOND INSTANCE DIES ON EADDRINUSE and the stack trace buries the reason.
# lsof is not everywhere, so a failure to look is not a failure to start.
if command -v lsof >/dev/null 2>&1 && lsof -nPi :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  printf '\n  Something is already listening on %s.\n' "$PORT"
  printf '  That is probably this server already running - open http://127.0.0.1:%s\n' "$PORT"
  printf '  To restart it, stop that one first, or:  PORT=8801 ./start.sh\n\n'
  exit 1
fi

# NO KEY IS NOT A REASON NOT TO START. The page has a button for it now, and
# everything free works without one.
if [ ! -f .env ] && [ -z "$COMFY_API_KEY" ]; then
  printf '\n  No .env yet - press the key in the top right of the page and paste\n'
  printf '  your Comfy key in. Everything free works without one.\n'
fi

printf '\n  Hero'\''s Journey  ->  http://127.0.0.1:%s\n  Ctrl-C to stop.\n\n' "$PORT"

# THE PAGE OPENS ITSELF, and the server does the opening - from here it could
# only be launched before node and would race the socket.
[ "$1" = "noopen" ] || HJ_OPEN=1
export HJ_OPEN PORT

exec node server.js
