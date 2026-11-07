#!/usr/bin/env bash
set -euo pipefail
quietchat_root="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
if [[ "${1:-}" == start ]]; then shift; fi
case "${1:-}" in
  --terminal) shift; exec "$quietchat_root/run.sh" "$@" ;;
  --version|--clear-cache|--reset-session) exec "$quietchat_root/run.sh" "$@" ;;
  --desktop|--gtk) shift ;;
  --help|-h)
    cat <<'HELP'
QuietChat — native GTK4 WhatsApp companion

quietchat                       Open the native interface (saved login)
quietchat --demo                Offline native demo; no account/network
quietchat --background          Start in the tray when available
quietchat --data-dir DIRECTORY  Use another private state directory
quietchat --terminal            Original terminal interface
quietchat --terminal --demo     Original offline terminal demo
quietchat --version             Show the version and source checkout
quietchat --clear-cache         Clear downloaded media
quietchat --terminal --reset-session   Forget login and pair again

The application icon and this command launch the same checkout.
Enter sends; Shift+Enter adds a line. Select text normally and use Ctrl+C/V.
F8 replies, F3 attaches, F9 searches, Ctrl+Q quits. Closing hides to the tray
when a system tray is available; use the menu to quit fully.
HELP
    exit 0 ;;
esac
exec "$quietchat_root/native.sh" "$@"
