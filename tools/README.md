# tools/

Repo build utilities. Currently:

## `build-whitepaper-pdf.sh`

Renders `WHITEPAPER.md` → `whitepaper.pdf` for circulation.

### Requirements

- **pandoc** 3.x — either on `$PATH` (`apt install pandoc` / `brew install pandoc`) or via the bundled-binary Python package, which works without sudo:

  ```bash
  python3 -m venv /tmp/pandoc-venv
  /tmp/pandoc-venv/bin/pip install pypandoc-binary
  export PANDOC=/tmp/pandoc-venv/lib/python3.12/site-packages/pypandoc/files/pandoc
  ```

- **TeX Live** with `pdflatex`. On Debian/Ubuntu, `texlive-latex-base texlive-latex-recommended texlive-fonts-recommended` is enough; `texlive-fonts-extra` helps with the section symbol and a few box-drawing glyphs.

### Build

```bash
tools/build-whitepaper-pdf.sh                          # uses $PATH pandoc
PANDOC=/path/to/pandoc tools/build-whitepaper-pdf.sh   # explicit binary
```

Output: `whitepaper.pdf` at the repo root. ~330 KB, 20 pages.

### Why this is more than a one-liner

`pandoc WHITEPAPER.md -o whitepaper.pdf` fails on stock TeX Live for two reasons that the build script handles:

1. **Unicode in code blocks.** The whitepaper's leaf-schema and architecture diagrams use box-drawing characters (─│┌┐), arrows (→), and check/cross marks (✓✗). `pdflatex` with `inputenc utf8` does not declare these by default. `whitepaper-header.tex` maps each to a renderable equivalent so the verbatim environments don't reject them.

2. **The manual title block.** `WHITEPAPER.md` opens with a human-readable title block (good for GitHub rendering) that would otherwise produce a duplicate title page in the PDF. The script strips everything before `## Abstract` and reconstructs the title page from pandoc metadata variables.

If/when the system gets `texlive-luatex` (for `luaotfload`), the script can switch back to `--pdf-engine=lualatex` with `--variable=mainfont:"DejaVu Serif"` (etc.) for richer typography. We deliberately stayed on `pdflatex` so the build works on a minimal TeX install.
