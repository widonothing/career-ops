# About this fork

This is [career-ops](https://github.com/career-ops-hq/career-ops) (MIT) at release v1.35.0, plus three small additions. No personal data is included: the CV, profile, tracker, reports and generated PDFs are all git-ignored, so you start with a clean setup.

## Getting started

```bash
git clone https://github.com/widonothing/career-ops.git
cd career-ops
npm install
npx playwright install chromium
printf 'FORK-NOTES.md\ntools/\n' > config/local-paths.txt   # declares this fork's own files
claude          # then say hi — the onboarding asks for your CV and targets
```

`config/local-paths.txt` tells the updater and the test suite that `FORK-NOTES.md` and `tools/` belong to this fork. It's git-ignored by design, so every clone creates it once; without it, `node test-all.mjs` reports a "SYSTEM_PATHS coverage gap".

The upstream [README](README.md) has the full documentation.

## What's added

1. **Scanner fixes** — small fixes in `scan.mjs`, `providers/oraclecloud.mjs` and `providers/rippling.mjs`.
2. **`nordic` CV template** (`templates/nordic/`) — a quiet one-page A4 layout: one column, Lato 10pt, one navy accent, job title + dates on one line. Turn it on in `config/profile.yml`:

   ```yaml
   cv:
     template: nordic
   ```

   A matching **cover letter** template ships in the same folder, so the CV and letter look like a set:

   ```yaml
   cover_letter:
     template: nordic
   ```

   Both use the **Lato** font, which must be installed on your machine (Ubuntu: `sudo apt install fonts-lato`; Windows/macOS: download from Google Fonts and install). Without it the CV falls back to Arial-like fonts.
3. **People viewer** (`tools/people-viewer/`) — a read-only local web page to browse the offers, scores and reports of one or more people's career-ops folders:

   ```bash
   node tools/people-viewer/server.mjs      # → http://127.0.0.1:4747
   ```

   It shows this checkout's own data, plus every folder inside `~/career-ops-people/` that has a tracker (`--people <dir>` to change). It only reads files and listens on localhost.

## Updates

`node update-system.mjs check` keeps working against the official releases. An update can overwrite the three scanner files; the template and the viewer live in their own folders.
