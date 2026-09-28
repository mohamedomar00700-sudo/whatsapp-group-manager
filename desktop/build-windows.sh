#!/usr/bin/env bash
# Builds dist/WhatsAppGroupManager.exe (Windows, no install needed) using Node SEA.
# Run from the repo root on Linux/macOS after `npm install`.
set -euo pipefail
NODE_VER=22.23.3
OUT=dist; TMP=$(mktemp -d)
mkdir -p "$OUT"
npm i --no-save esbuild postject >/dev/null
(cd "$TMP" && npm pack -q node-win-x64@$NODE_VER node-linux-x64@$NODE_VER >/dev/null \
  && mkdir win lin && tar xzf node-win-x64-$NODE_VER.tgz -C win && tar xzf node-linux-x64-$NODE_VER.tgz -C lin)

npx esbuild desktop/entry.mjs --bundle --platform=node --target=node22 --format=cjs --outfile="$TMP/app.cjs" \
  --define:import.meta.url=__import_meta_url \
  --banner:js="const __import_meta_url = require('url').pathToFileURL(__filename).href;" \
  --external:sharp --external:jimp --external:link-preview-js --external:qrcode-terminal --external:audio-decode

cp public/index.html public/app.js public/style.css "$TMP/"
cp node_modules/socket.io/client-dist/socket.io.min.js "$TMP/socket.io.js"
cat > "$TMP/sea-config.json" <<JSON
{ "main": "app.cjs", "output": "sea-prep.blob", "disableExperimentalSEAWarning": true,
  "useSnapshot": false, "useCodeCache": false,
  "assets": { "index.html": "index.html", "app.js": "app.js", "style.css": "style.css", "socket.io.js": "socket.io.js" } }
JSON
(cd "$TMP" && ./lin/package/bin/node --experimental-sea-config sea-config.json)

# Remove the original Node signature (it becomes invalid after injection)
python3 - "$TMP/win/package/bin/node.exe" "$OUT/WhatsAppGroupManager.exe" <<'PY'
import sys, pefile
pe = pefile.PE(sys.argv[1], fast_load=True)
d = pe.OPTIONAL_HEADER.DATA_DIRECTORY[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_SECURITY']]
off, size = d.VirtualAddress, d.Size
d.VirtualAddress = 0; d.Size = 0
data = bytearray(pe.write())
if off and off + size == len(data): data = data[:off]
open(sys.argv[2], 'wb').write(data)
PY
npx postject "$OUT/WhatsAppGroupManager.exe" NODE_SEA_BLOB "$TMP/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
echo "Built $OUT/WhatsAppGroupManager.exe"
