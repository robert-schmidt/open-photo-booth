# Changelog

All notable changes to Open Photo Booth are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-18

First public release.

### Added

- **Booth flow:** a touch-to-start screen with a live mirrored camera preview, a countdown, multi-shot sessions, a flash effect and a review screen with Retake, Print and Done that returns to the start screen on its own.
- **Built-in layouts:** classic 2×6 strip, postcard (one large and three small), grid of four, and single photo.
- **Layout editor:**
  - Create, edit, duplicate, delete and "use in booth" layouts.
  - Add photo slots, text, images, rectangles and ellipses.
  - Drag to move and resize; set colours with transparency, opacity, borders, shadows, rotation and layer order.
  - Undo/redo and keyboard shortcuts.
  - Paper size presets from 2×6 to 6×8.
- **Template import:** imports `template.xml` folders, the format used by dslrBooth/LumaBooth-style templates, including UTF-16 files and absolute Windows image paths.
- **Text:** `{event}` and `{date}` placeholders; text shrinks to fit its box.
- **Filters:** black & white, sepia, warm, vivid and faded, with a live layout preview in settings.
- **Printing:** silent printing to a chosen printer or through the system dialog, auto-print, copies, and 2×6 strips printed 2-up on 4×6 paper.
- **Storage:** each session is saved as soon as it's captured (individual shots and the finished layout) into a folder per event.
- **Kiosk mode:** fullscreen, the display is kept awake, settings are hidden behind a long-press or Ctrl/Cmd + `,`, and there's an optional settings PIN.
- **Settings:** event name, start button text, camera, mirror, layout, filter, countdown, pause between shots, review time, photo folder, printer, copies, auto-print and 2-up strips.
- **Input:** `Space`/`Enter` start a session, for USB buttons and foot pedals.
- **Installers:** macOS (Apple Silicon and Intel, ad-hoc signed) and Windows, built and published by GitHub Actions.

[0.1.0]: https://github.com/robert-schmidt/open-photo-booth/releases/tag/v0.1.0
