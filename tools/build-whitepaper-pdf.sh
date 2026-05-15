#!/usr/bin/env bash
# Render WHITEPAPER.md to whitepaper.pdf using pandoc + the Eisvogel template.
#
# Requirements:
#   - pandoc 3.x  (apt install pandoc, or via the bundled pypandoc-binary
#                  python package: python3 -m venv .venv && .venv/bin/pip
#                  install pypandoc-binary, then point $PANDOC at the binary
#                  it installs)
#   - pdflatex via TeX Live
#   - tools/eisvogel.latex template, included in the repo
#
# Usage:
#   tools/build-whitepaper-pdf.sh                 # default — use $PATH pandoc
#   PANDOC=/path/to/pandoc tools/build-whitepaper-pdf.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PANDOC="${PANDOC:-pandoc}"
if ! command -v "$PANDOC" >/dev/null 2>&1; then
  echo "error: pandoc not found at '$PANDOC'." >&2
  echo "       install with 'apt install pandoc' or set PANDOC to a binary." >&2
  exit 1
fi

if [ ! -f tools/eisvogel.latex ]; then
  echo "error: tools/eisvogel.latex missing." >&2
  exit 1
fi

# Strip the manual title block from the markdown so the LaTeX title-page
# variables drive the cover page instead. We don't modify WHITEPAPER.md
# on disk; the sed pipeline runs inline.
STRIPPED=$(mktemp --suffix=.md)
trap 'rm -f "$STRIPPED"' EXIT
sed -n '/^## Abstract$/,$p' WHITEPAPER.md > "$STRIPPED"

CITATION="G. J. Ward, B. W. Daugherty, S. M. Ryan"

"$PANDOC" "$STRIPPED" \
  --from=gfm+yaml_metadata_block \
  --to=pdf \
  --pdf-engine=pdflatex \
  --include-in-header=tools/whitepaper-header.tex \
  --no-highlight \
  --top-level-division=section \
  --variable=title:"No Trust in the Agent" \
  --variable=subtitle:"Cryptographic Audit Trails for AI Tool Use" \
  --variable=author:"$CITATION" \
  --variable=date:"v1.0 — May 2026" \
  --variable=lang:en \
  --variable=geometry:margin=1in \
  --variable=fontsize:11pt \
  --variable=mainfont:"DejaVu Serif" \
  --variable=sansfont:"DejaVu Sans" \
  --variable=monofont:"DejaVu Sans Mono" \
  --variable=colorlinks:true \
  --variable=linkcolor:NavyBlue \
  --variable=urlcolor:NavyBlue \
  --variable=toc-depth:2 \
  --toc \
  --output=whitepaper.pdf

echo "wrote whitepaper.pdf"
ls -la whitepaper.pdf
