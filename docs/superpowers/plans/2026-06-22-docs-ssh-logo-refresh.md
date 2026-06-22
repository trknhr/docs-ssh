# docs-ssh Logo Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current docs-plus-terminal mark with the approved B1 terminal-window SSH logo in both the site and viewer.

**Architecture:** The logo remains a static brand asset served from each app's existing `public/brand` directory. Both apps use identical SVG content, and each app keeps its own generated 180px PNG for apple-touch-icon support. The existing HTML and CSS wiring stays unchanged.

**Tech Stack:** SVG, PNG generated with macOS `sips`, Vite site build, Vite/React viewer build, pnpm.

---

## File Structure

- Modify: `.gitignore`
  - Keep local `.superpowers/brainstorm` mockups out of Git.
- Modify: `site/public/brand/docs-ssh-mark.svg`
  - Source SVG for the documentation site favicon and header logo.
- Modify: `viewer/public/brand/docs-ssh-mark.svg`
  - Source SVG for the viewer favicon and topbar logo. Must match the site SVG byte-for-byte.
- Modify: `site/public/brand/docs-ssh-mark-180.png`
  - 180px raster icon generated from the site SVG.
- Modify: `viewer/public/brand/docs-ssh-mark-180.png`
  - 180px raster icon generated from the viewer SVG.

No TypeScript, route, server, or CSS changes are needed for the approved logo refresh.

---

### Task 1: Keep Brainstorming Artifacts Ignored

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Verify `.superpowers/` is ignored**

Run:

```bash
rg -n '^\.superpowers/$' .gitignore
```

Expected: one matching line:

```text
10:.superpowers/
```

- [ ] **Step 2: Add the ignore entry if missing**

If Step 1 does not print `.superpowers/`, append this exact line to `.gitignore` using `apply_patch`:

```gitignore
.superpowers/
```

- [ ] **Step 3: Confirm mockups are not tracked**

Run:

```bash
git status --short .superpowers .gitignore
```

Expected: `.superpowers/` does not appear. `.gitignore` may appear as modified:

```text
 M .gitignore
```

---

### Task 2: Replace the Shared SVG Logo

**Files:**
- Modify: `site/public/brand/docs-ssh-mark.svg`
- Modify: `viewer/public/brand/docs-ssh-mark.svg`

- [ ] **Step 1: Replace the site SVG**

Replace the complete contents of `site/public/brand/docs-ssh-mark.svg` with this exact SVG:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="docs-ssh">
  <rect width="512" height="512" rx="92" fill="#e7f5ff"/>
  <rect x="56" y="86" width="400" height="340" rx="36" fill="#f8fafc" stroke="#0b0f14" stroke-width="22"/>
  <path d="M66 146h380" stroke="#0b0f14" stroke-width="22"/>
  <circle cx="116" cy="116" r="13" fill="#ff5f57"/>
  <circle cx="158" cy="116" r="13" fill="#ffbd2e"/>
  <circle cx="200" cy="116" r="13" fill="#28c840"/>
  <path d="m128 196 64 52-64 52" fill="none" stroke="#0b0f14" stroke-linecap="round" stroke-linejoin="round" stroke-width="34"/>
  <path d="M224 298h88" fill="none" stroke="#0b0f14" stroke-linecap="round" stroke-width="34"/>
  <text x="292" y="398" text-anchor="middle" font-family="SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace" font-size="78" font-weight="900" fill="#0b0f14" letter-spacing="5">SSH</text>
</svg>
```

- [ ] **Step 2: Copy the same SVG into the viewer**

Run:

```bash
cp site/public/brand/docs-ssh-mark.svg viewer/public/brand/docs-ssh-mark.svg
```

- [ ] **Step 3: Verify both SVG files match exactly**

Run:

```bash
cmp -s site/public/brand/docs-ssh-mark.svg viewer/public/brand/docs-ssh-mark.svg && echo "SVG assets match"
```

Expected:

```text
SVG assets match
```

- [ ] **Step 4: Verify the approved B1 geometry is present**

Run:

```bash
rg -n 'm128 196 64 52-64 52|M224 298h88|font-size="78"|y="398"' site/public/brand/docs-ssh-mark.svg
```

Expected: four matches showing the B1 prompt, underscore, and SSH placement.

---

### Task 3: Regenerate 180px PNG Icons

**Files:**
- Modify: `site/public/brand/docs-ssh-mark-180.png`
- Modify: `viewer/public/brand/docs-ssh-mark-180.png`

- [ ] **Step 1: Generate a 512px PNG from the site SVG**

Run:

```bash
sips -s format png site/public/brand/docs-ssh-mark.svg --out /tmp/docs-ssh-mark-512.png
```

Expected: `sips` prints both the SVG input and `/tmp/docs-ssh-mark-512.png` output path.

- [ ] **Step 2: Resize it to the apple-touch-icon size**

Run:

```bash
sips -z 180 180 /tmp/docs-ssh-mark-512.png --out site/public/brand/docs-ssh-mark-180.png
```

Expected: `sips` prints `/tmp/docs-ssh-mark-512.png` and `site/public/brand/docs-ssh-mark-180.png`.

- [ ] **Step 3: Copy the generated PNG into the viewer**

Run:

```bash
cp site/public/brand/docs-ssh-mark-180.png viewer/public/brand/docs-ssh-mark-180.png
```

- [ ] **Step 4: Verify PNG dimensions**

Run:

```bash
file site/public/brand/docs-ssh-mark-180.png viewer/public/brand/docs-ssh-mark-180.png
```

Expected: both lines include:

```text
PNG image data, 180 x 180, 8-bit/color RGBA, non-interlaced
```

- [ ] **Step 5: Verify both PNG files match exactly**

Run:

```bash
cmp -s site/public/brand/docs-ssh-mark-180.png viewer/public/brand/docs-ssh-mark-180.png && echo "PNG assets match"
```

Expected:

```text
PNG assets match
```

---

### Task 4: Visual and Build Verification

**Files:**
- Inspect: `site/public/brand/docs-ssh-mark.svg`
- Inspect: `site/public/brand/docs-ssh-mark-180.png`
- Existing build outputs: `site-dist/`, `viewer-dist/`

- [ ] **Step 1: Open the SVG for visual inspection**

Run:

```bash
open site/public/brand/docs-ssh-mark.svg
```

Expected: the browser or preview app shows a pale blue terminal-window mark with a black `>_` prompt and `SSH` label. The `>_` and `SSH` lines have a moderate gap matching B1.

- [ ] **Step 2: Open the generated PNG for visual inspection**

Run:

```bash
open site/public/brand/docs-ssh-mark-180.png
```

Expected: the PNG shows the same mark without obvious cropping, blur, or spacing regression.

- [ ] **Step 3: Build the documentation site**

Run:

```bash
pnpm run site:build
```

Expected: TypeScript check and Vite build complete successfully.

- [ ] **Step 4: Build the viewer**

Run:

```bash
pnpm run build:viewer
```

Expected: Vite build completes successfully.

- [ ] **Step 5: Review the final diff**

Run:

```bash
git diff -- .gitignore site/public/brand viewer/public/brand site/index.html site/src/styles.css viewer/index.html viewer/src/App.tsx viewer/src/styles.css
```

Expected: the diff contains the B1 SVG content, regenerated binary PNGs, `.superpowers/` ignored, and the existing logo wiring changes. It should not contain unrelated TypeScript or server changes.

---

### Task 5: Commit the Logo Refresh

**Files:**
- Commit: `.gitignore`
- Commit: `site/index.html`
- Commit: `site/src/styles.css`
- Commit: `site/public/brand/docs-ssh-mark.svg`
- Commit: `site/public/brand/docs-ssh-mark-180.png`
- Commit: `viewer/index.html`
- Commit: `viewer/src/App.tsx`
- Commit: `viewer/src/styles.css`
- Commit: `viewer/public/brand/docs-ssh-mark.svg`
- Commit: `viewer/public/brand/docs-ssh-mark-180.png`
- Commit: `docs/superpowers/plans/2026-06-22-docs-ssh-logo-refresh.md`

- [ ] **Step 1: Stage only the logo refresh files**

Run:

```bash
git add .gitignore \
  site/index.html site/src/styles.css site/public/brand \
  viewer/index.html viewer/src/App.tsx viewer/src/styles.css viewer/public/brand \
  docs/superpowers/plans/2026-06-22-docs-ssh-logo-refresh.md
```

- [ ] **Step 2: Confirm staged scope**

Run:

```bash
git diff --cached --stat
```

Expected: staged changes are limited to the files listed in this task.

- [ ] **Step 3: Commit**

Run:

```bash
git commit -m "style: Refresh docs-ssh brand mark" -m "Co-Authored-By: Codex <codex@openai.com>"
```

Expected: Git creates one commit for the logo refresh. Do not run `git push`.
