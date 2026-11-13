#!/bin/sh
# Build the Windows x64 installer on a Mac.
# node-gyp cannot cross-compile, so instead of rebuilding the native modules we
# swap in their prebuilt Windows binaries for the build and put the Mac ones back.
set -e
cd "$(dirname "$0")/.."
export PATH="/usr/local/bin:$PATH"
STASH="$(mktemp -d)"
cp -R node_modules/better-sqlite3/build "$STASH/bsq-build"
mv node_modules/node-pty/build "$STASH/pty-build"
restore() {
  rm -rf node_modules/better-sqlite3/build
  cp -R "$STASH/bsq-build" node_modules/better-sqlite3/build
  mv "$STASH/pty-build" node_modules/node-pty/build
}
trap restore EXIT
# Windows crash guard for node-pty (the upstream postinstall only applies it on Windows).
sed "s/if (process.platform !== 'win32') process.exit(0);//" tools/patch-node-pty-conpty.cjs > "$STASH/patch.cjs"
node "$STASH/patch.cjs" || true
(cd node_modules/better-sqlite3 && npx prebuild-install --runtime electron --target "$(node -p "require('electron/package.json').version")" --arch x64 --platform win32)
npx electron-vite build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win nsis --x64 --publish never -c.npmRebuild=false
