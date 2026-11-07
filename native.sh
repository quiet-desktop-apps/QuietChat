#!/usr/bin/env bash
set -euo pipefail
quietchat_root="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
cd -- "$quietchat_root"
/usr/bin/python3 -c 'import gi; gi.require_version("Gtk", "4.0"); from gi.repository import Gtk' || {
  echo 'QuietChat requires the Ubuntu python3-gi and gir1.2-gtk-4.0 packages.' >&2
  exit 1
}
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 16)) process.exit(1)'
if [[ ! -d node_modules ]]; then npm ci --no-fund --no-audit; fi
npm run build --silent
export GSK_RENDERER="${GSK_RENDERER:-cairo}"
exec /usr/bin/python3 "$quietchat_root/native/app.py" "$@"
