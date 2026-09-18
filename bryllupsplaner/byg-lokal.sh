#!/usr/bin/env bash
# Pakker Artifact-kilderne ind i det skelet, platformen selv lægger på ved
# publicering, så de kan åbnes lokalt præcis som i den publicerede udgave.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p _lokal

for src in bryllupsagenten.html oversigt.html; do
  out="_lokal/$src"
  {
    printf '%s' '<!doctype html><html lang="da"><head><meta charset="utf-8">'
    printf '%s' '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    printf '%s' '<style>:root{color-scheme:light dark;padding-top:env(safe-area-inset-top,0px);'
    printf '%s' 'padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui}'
    printf '%s' 'img{max-width:100%}[hidden]{display:none!important}</style></head><body>'
    cat "$src"
    printf '%s' '</body></html>'
  } > "$out"
  echo "skrev $out"
done

echo
echo "Åbn dem med:  open _lokal/oversigt.html   (macOS)"
echo "              xdg-open _lokal/oversigt.html   (Linux)"
