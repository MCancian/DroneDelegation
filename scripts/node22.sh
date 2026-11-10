#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tooling_root="$(cd "$SCRIPT_DIR/.." && pwd)"
tooling_cache="$tooling_root/.cache/node22"
NODE_VERSION="22.14.0"
NPM_VERSION="10.9.2"

# Platform check
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Linux" ] || [ "$ARCH" != "x86_64" ]; then
  echo "ERROR: scripts/node22.sh supports Linux x86_64 only (detected: $OS $ARCH)." >&2
  echo "Install Node.js $NODE_VERSION and npm $NPM_VERSION manually, then run commands directly." >&2
  exit 1
fi

# Resolve paths
tooling_node_bin="$tooling_cache/node_modules/node-linux-x64/bin/node"
tooling_npm_cli="$tooling_cache/node_modules/npm/bin/npm-cli.js"

# tooling_runtime_valid returns 0 only if both node binary and npm CLI are valid.
# Captured commands use || return 1 to prevent set -e from escaping on failure.
tooling_runtime_valid() {
  if [ ! -x "$tooling_node_bin" ]; then
    return 1
  fi
  local actual_node
  actual_node="$("$tooling_node_bin" --version 2>/dev/null)" || return 1
  if [ "$actual_node" != "v${NODE_VERSION}" ]; then
    return 1
  fi
  if [ ! -f "$tooling_npm_cli" ]; then
    return 1
  fi
  local actual_npm
  actual_npm="$("$tooling_node_bin" "$tooling_npm_cli" --version 2>/dev/null)" || return 1
  if [ "$actual_npm" != "$NPM_VERSION" ]; then
    return 1
  fi
  return 0
}

# Determine if install is needed (checks both node AND npm)
needs_install=false
if ! tooling_runtime_valid; then
  needs_install=true
fi

if [ "$needs_install" = true ]; then
  mkdir -p "$tooling_cache"
  LOCK="$tooling_cache/.bootstrap.lock"
  exec 9>"$LOCK"
  flock 9
  # Re-check after acquiring lock (both node and npm)
  if ! tooling_runtime_valid; then
    npm install --prefix "$tooling_cache" --ignore-scripts --no-save --package-lock=false \
      "node-linux-x64@${NODE_VERSION}" "npm@${NPM_VERSION}"
  fi
  exec 9>&-
fi

# Validate after bootstrap
ACTUAL_NODE="$("$tooling_node_bin" --version)"
if [ "$ACTUAL_NODE" != "v${NODE_VERSION}" ]; then
  echo "ERROR: expected node v${NODE_VERSION}, got ${ACTUAL_NODE}" >&2
  exit 1
fi

ACTUAL_NPM="$("$tooling_node_bin" "$tooling_npm_cli" --version)"
if [ "$ACTUAL_NPM" != "$NPM_VERSION" ]; then
  echo "ERROR: expected npm ${NPM_VERSION}, got ${ACTUAL_NPM}" >&2
  exit 1
fi

# Export environment
NODE_DIR="$(dirname "$tooling_node_bin")"
export PATH="$NODE_DIR:$tooling_cache/node_modules/.bin:$PATH"
export JARVIS_NODE="$tooling_node_bin"

cd "$tooling_root"

if [ $# -eq 0 ]; then
  exec npm run verify
else
  exec "$@"
fi
