# Changelog

All notable changes to Open Photo Booth are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Camera settings in the app**, for cameras the booth controls over USB (Sony, Nikon Z): exposure mode, ISO, shutter speed, aperture, brightness (exposure compensation), white balance, flash mode and flash strength, under **Settings → Camera**. Each list shows what the camera offers right now, and a change goes to the camera at once. What the camera's own dial decides is shown greyed out.
- **Auto** hands the exposure to the camera for every photo (program auto, auto ISO and white balance, no compensation), and turns its flash on when one is found.
- **Set exposure from test shots** takes up to four test shots, measures each, and adjusts the camera until the photo is well exposed: by ISO when the camera is in manual (the way to shoot with studio flashes), by exposure compensation otherwise. It measures real photos, so the flash is in them.
- The settings say whether the camera's flash is ready (Nikon; Sony cameras don't report it).
- `camera-helper probe` also lists the camera's settings.

These are checked with the simulated camera only; like the rest of camera control, they haven't been tried on real Sony or Nikon bodies yet.

## [0.2.1] - 2026-11-25

### Changed

- **Much smaller downloads:** about 150 MB instead of 1 GB. The face swap models are no longer inside the installers. The booth downloads them once, the first time face swap is turned on (about 450 to 700 MB, needs internet that one time), and works offline after that.
- The setup guide, the start screen and **Settings → Face swap** say when that download will happen, show its progress, and offer **Download now** and **Try again**.

### Removed

- **Install from folder…** for the face swap models: the booth fetches them itself.

## [0.2.0] - 2026-11-25

### Added

- **Setup guide:** on first launch and for each new event, a few steps name the event, pick its layout and choose what guests can do.
- **Events:** any number of events, each with its own settings, dated photo folder (`YYYY-MM-DD Event name`) and a `sessions.jsonl` log of sessions and prints. The camera, printer, photos folder, kiosk mode and PIN stay with the computer.
- **Editing screen** in place of the old review screen:
  - Guests pick a look for all photos or just one, shown as thumbnails of their own photo.
  - Retake a single photo; the other photos and edits are kept.
  - Stickers (emoji and your own PNGs) that guests drag, pinch and turn, and face props that land on every face.
  - The screen finishes by itself after the idle time, shown on the Done button; any touch restarts it. Auto-print prints the edited layout.
- **Looks and effects, all on the booth:** auto-enhance, glam (skin smoothing), comic and sketch looks, background replacement (blur, backdrops or your own images), green screen, and no-blink shots.
- **Boomerangs and video messages** next to photos, saved as MP4. A boomerang also prints as a flip-book layout.
- **Face swap** into your own scenes, and live characters on the start screen. The downloads have its models built in; see the README for their licence.
- **Camera control (beta):** recent Sony and Nikon Z cameras plugged in by USB are listed by name under **Settings → Camera** and controlled directly: live view as the preview, the camera's own shutter and flash, and its full-resolution file saved. Focus at "1" in the countdown, a **Test shot** button, the camera's battery in the settings, and a fallback to the webcam while the camera is unplugged. In the macOS downloads; not yet in the Windows one.
- The settings list every camera model the booth controls, and say what resolution the camera in use delivers.
- The countdown preview is cut to the shape of the photo and follows the faces; photos are cropped around faces too.
- A hint on the start screen says how to open the settings until they've been opened once.
- **Settings → About** shows the version and a link to the project's page.
- `npm run e2e`: an end-to-end check that drives the real app with a fake camera through the setup guide, sessions, a simulated controlled camera, events, editing, boomerangs and videos, the settings PIN and the layout editor, in a throwaway profile.

### Changed

- The settings open with a ⚙️ button on the start screen instead of a long press on the corner (Ctrl/Cmd + `,` still works), and the setup guide offers to set the settings PIN.
- "Review screen (s)" is now "Finish after no touch for (s)", 45 seconds by default.
- Settings and the event list are written safely, so a power cut can't leave the booth without its PIN or photos folder.
- Release builds are hardened (Electron fuses) and the app is served from its own `app://` address.

- Inside an event's folder, finished layouts stay on top and the rest is filed by type: `Originals/`, `Prints/`, `Videos/`.

### Upgrading from 0.1.0

Your settings become the first event, and it keeps using its existing `<event name>` photo folder. Photos already in it stay where they are; new sessions use the folders by type.

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

[Unreleased]: https://github.com/robert-schmidt/open-photo-booth/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/robert-schmidt/open-photo-booth/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/robert-schmidt/open-photo-booth/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/robert-schmidt/open-photo-booth/releases/tag/v0.1.0
