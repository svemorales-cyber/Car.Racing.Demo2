#!/bin/sh
# Builds dist/: the game with js/game.js obfuscated, ready to upload to the site.
# Needs Node.js (nodejs.org). Run from this folder:  sh build-dist.sh
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist/js dist/css dist/controls
cp index.html dist/ && cp css/style.css dist/css/ && cp controls/controls.wasm dist/controls/
mkdir -p dist/models && cp models/*.glb dist/models/
npx --yes javascript-obfuscator@4.1.1 js/game.js --output dist/js/game.js --config obfuscator.json && echo "ok -> dist/"
