# Open Photo Booth

A free, open-source photo booth app for **Windows** and **macOS**. Live camera preview, countdown, multi-photo layouts, filters and printing, ready for weddings, parties and events.

## Features

- **Attract screen**: live mirrored preview with "Touch to start"
- **Sessions**: countdown, flash and multi-shot capture; the layout decides how many photos are taken
- **Layouts**: classic 2×6 strip, postcard (1 large + 3 small), grid of four and single photo, or import your own
- **Filters**: black & white, sepia, warm, vivid, faded
- **Printing**: silent printing to a chosen printer, auto-print, copies, and 2×6 strips printed 2-up on 4×6 paper
- **Storage**: saves every shot plus the final layout to `Pictures/Open Photo Booth/<event name>/`
- **Kiosk mode**: fullscreen operation; settings stay hidden behind a 1.5 s press on the top-right corner (or `Ctrl/Cmd + ,`)
- **Buttons and pedals**: `Space` / `Enter` start a session, so USB foot pedals and arcade buttons work out of the box

## Download

Get the latest `.dmg` (macOS, Apple Silicon and Intel) or `.exe` (Windows) from [Releases](../../releases).

The builds are not code-signed by a paid developer account, so the first launch needs one extra click:

- **macOS**: right-click the app → **Open**, or System Settings → Privacy & Security → **Open Anyway**.
- **Windows**: on the SmartScreen prompt choose **More info** → **Run anyway**.

## Cameras

Any webcam works. For DSLR or mirrorless quality, use your camera maker's webcam utility (Canon EOS Webcam Utility, Sony Imaging Edge Webcam, Nikon Webcam Utility, Fujifilm X Webcam) or an HDMI capture card, then pick the camera under **Settings → Camera**.

## Custom layouts

A layout is a folder with a `template.xml` and any images it references. Sizes are in pixels at `Resolution` DPI (600×1800 at 300 DPI is a 2×6 strip). Colors are `#AARRGGBB`.

```xml
<Template Name="My strip" Width="600" Height="1800" Resolution="300" BackgroundColor="#FFFFFFFF">
  <Elements>
    <Photo PhotoNumber="1" Left="30" Top="30" Width="540" Height="360" ZIndex="0" />
    <Image ImagePath="frame.png" Left="0" Top="0" Width="600" Height="1800" ZIndex="5" />
    <Text Text="{event} · {date}" FontName="Georgia" FontSize="48" FontColor="#FF222222"
          TextAlignment="Center" Left="0" Top="1600" Width="600" Height="120" ZIndex="6" />
  </Elements>
</Template>
```

Supported elements: `Photo`, `Image`, `Text`, `Rectangle`, `Ellipse`, with optional `Opacity`, `Rotation`, `Thickness`/`StrokeColor`, `Fill` and shadows. The format matches the `template.xml` files used by dslrBooth/LumaBooth-style templates, so many existing layouts import directly. Import a layout under **Settings → Layout → Import…**.

## Development

```bash
npm install
npm start      # run the app
npm test       # layout and template self-check
npm run dist   # build installers for the current OS into dist/
```

## Releasing

Bump `version` in `package.json`, then:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

GitHub Actions builds the macOS and Windows installers and attaches them to a draft release. Publish the draft when you're happy.

## License

MIT. Open Photo Booth is an independent project and is not affiliated with Lumasoft, LumaBooth or dslrBooth; those names are used only to describe file-format compatibility.
