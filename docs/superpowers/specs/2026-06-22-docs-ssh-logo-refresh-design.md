# docs-ssh Logo Refresh Design

## Context

The site and viewer now load shared brand assets from `public/brand`, but the
current mark reads more like "docs plus terminal" than SSH. The replacement
should make the SSH association immediate at favicon, topbar, and browser tab
sizes.

## Decision

Use a terminal-window mark based on the selected B1 spacing option.

The final SVG should show a light terminal window with a dark outline, a top
chrome bar, a `>_` prompt line, and a bold `SSH` label below it. The prompt and
label should have enough vertical separation that the underscore does not crowd
the top of the `SSH` letters, while keeping `SSH` large enough to stay legible
at small sizes.

## Assets

- Replace `site/public/brand/docs-ssh-mark.svg`.
- Replace `viewer/public/brand/docs-ssh-mark.svg` with the same SVG content.
- Regenerate `docs-ssh-mark-180.png` in both `site/public/brand` and
  `viewer/public/brand` from the final SVG.

## Visual Requirements

- The mark must still read as SSH at 32px.
- At 16px, the prompt shape and terminal window should remain recognizable even
  if the `SSH` letters are less readable.
- Use the B1 layout: prompt raised slightly, `SSH` lowered slightly, with a
  moderate gap rather than the roomier B2/B3 spacing.
- Keep the palette simple and high-contrast: pale blue outer shape, white
  terminal body, black terminal strokes and text, small traffic-light dots.

## Integration

Keep the existing HTML and CSS wiring:

- Site favicon and header mark continue to use `%BASE_URL%brand/docs-ssh-mark.*`.
- Viewer favicon and topbar mark continue to use `/brand/docs-ssh-mark.*`.
- No changes are needed to runtime behavior or server code.

## Testing

- Build the site with `pnpm run site:build`.
- Build the viewer with `pnpm run build:viewer`.
- Inspect the generated or source mark at large, 32px, and 16px sizes before
  calling the logo done.
