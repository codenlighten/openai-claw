#!/usr/bin/env bash
# Render WHITEPAPER.md to whitepaper.pdf using pandoc and pdflatex.
#
# Requirements:
#   - pdflatex via TeX Live  (apt install texlive-latex-recommended)
#   - tools/whitepaper-header.tex, included in the repo
#   - pandoc — pinned and provisioned automatically, see below
#
# pandoc is cached in a durable location rather than reinstalled into /tmp,
# which was wiped on every reboot and left the build unrunnable. The version is
# pinned so two people, or the same person twice, render the same bytes: an
# unpinned `pip install pypandoc-binary` would silently change the typesetting
# of a document people cite.
#
# This uses pandoc's default LaTeX template plus that header include. An earlier
# version of this script refused to run without tools/eisvogel.latex, a template
# it never actually passed to pandoc and which was never committed — so the
# build failed on any fresh clone, including for the authors.
#
# Usage:
#   tools/build-whitepaper-pdf.sh                          # provisions if needed
#   PANDOC=/path/to/pandoc tools/build-whitepaper-pdf.sh   # explicit override
set -euo pipefail
cd "$(dirname "$0")/.."

PYPANDOC_PIN="pypandoc-binary==1.17"   # provides pandoc 3.9
PANDOC_EXPECTED="3.9"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/openai-claw"
VENV="$CACHE_DIR/pandoc-venv"

resolve_pandoc() {
  if [ -n "${PANDOC:-}" ]; then
    command -v "$PANDOC" >/dev/null 2>&1 || { echo "error: PANDOC='$PANDOC' is not executable." >&2; exit 1; }
    echo "$PANDOC"; return
  fi
  local cached
  cached=$(ls "$VENV"/lib/python3*/site-packages/pypandoc/files/pandoc 2>/dev/null | head -1 || true)
  if [ -n "$cached" ] && [ -x "$cached" ]; then echo "$cached"; return; fi

  echo "pandoc not cached — provisioning $PYPANDOC_PIN into $VENV" >&2
  command -v python3 >/dev/null 2>&1 || { echo "error: python3 is needed to provision pandoc." >&2; exit 1; }
  mkdir -p "$CACHE_DIR"
  python3 -m venv "$VENV" >&2
  "$VENV/bin/pip" install --quiet "$PYPANDOC_PIN" >&2
  cached=$(ls "$VENV"/lib/python3*/site-packages/pypandoc/files/pandoc 2>/dev/null | head -1 || true)
  [ -n "$cached" ] || { echo "error: provisioning failed — no pandoc under $VENV." >&2; exit 1; }
  echo "$cached"
}

PANDOC=$(resolve_pandoc)
PANDOC_VERSION=$("$PANDOC" --version | head -1 | awk '{print $2}')
echo "using pandoc $PANDOC_VERSION ($PANDOC)"
if [ "$PANDOC_VERSION" != "$PANDOC_EXPECTED" ]; then
  echo "warning: pandoc $PANDOC_VERSION differs from the pinned $PANDOC_EXPECTED;" >&2
  echo "         rendering may not match the committed whitepaper.pdf." >&2
fi

command -v pdflatex >/dev/null 2>&1 || {
  echo "error: pdflatex not found (apt install texlive-latex-recommended)." >&2
  exit 1
}

# Deterministic output. Without this pdflatex stamps the current time into
# /CreationDate, so two builds of identical source differ in bytes and the
# committed PDF cannot be checked against the markdown it came from. Fixed to
# the commit date of WHITEPAPER.md so a rebuild reproduces the committed file.
if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
  SOURCE_DATE_EPOCH=$(git log -1 --format=%ct -- WHITEPAPER.md 2>/dev/null || echo 0)
fi
export SOURCE_DATE_EPOCH FORCE_SOURCE_DATE=1

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
  --variable=date:"v1.0.1 — September 2026" \
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
