#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null; then
  echo 'QuietChat requires Node.js 22.16 or newer.' >&2
  exit 1
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 16)) { console.error("QuietChat requires Node.js 22.16 or newer."); process.exit(1); }'
if [[ ! -d node_modules ]]; then
  echo 'Installing QuietChat dependencies…'
  npm ci --no-fund --no-audit
fi
npm run build --silent
exec node --disable-warning=ExperimentalWarning dist/src/main.js "$@"
