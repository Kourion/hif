# SONY HIF to JPG

An installable web app (PWA) that converts the 10-bit HEIF photos Sony cameras save as `.HIF` into JPGs that work in any phone app.
Everything happens on the device. Nothing is uploaded to the internet.
And after installation internet is also no longer needed.

- Reads 10-bit 4:2:2 and 4:2:0 HEIF from Sony Alpha cameras (and other HEIF/HEIC files).
- Keeps camera info (date, camera, lens, exposure) in the JPG, with an option to strip GPS location.
- Converts Sony's HLG stills (BT.2020 HDR) to normal SDR JPGs with highlight roll-off.
- Uses several CPU cores. The tiles of each photo are decoded in parallel (a dense 33 MP file: 8.3 s on one core, 3.8 s on four, in desktop Chromium).
- Saves to Downloads, shares to any app (Google Photos, WhatsApp and so on), or saves everything as one ZIP.
- Shows up in Android's share sheet, so you can send HIF files to it from Files or a gallery app.

## Install on Android

1. Go to https://kourion.github.io/hif/.
2. Tap **Install app** in the top right corner, or use Chrome's menu → **Install app** / **Add to Home screen**.
3. Open **HIF to JPG** from the home screen. It now runs offline.

To convert, tap **Open HIF photos** and pick the files, or select them in any other app and use **Share → HIF to JPG**.
Converted photos appear on a contact sheet. Tap one to view it, or use **Save all**, **Share** or **ZIP** at the bottom.
## Limitations

- Large photos need memory. Converting a 33 MP photo takes about 330 MB with one decoder and about 40 MB more for each extra one. The app picks the number of decoders from the phone's RAM and cores. If a phone still runs out, close other apps or choose a smaller size in Settings.
- HLG photos become SDR JPGs. The tone mapping is a reasonable default, not Sony's own rendering.
- Targets Chrome on Android (and desktop Chrome, Edge and Firefox). iOS Safari is not tested.

## Licences

The decoder in `app/vendor/libheif/` is libheif with libde265, licensed under the GNU LGPL 3.0 (see [`app/vendor/libheif/LICENSE`](app/vendor/libheif/LICENSE)). It is loaded as a separate file and can be replaced with another build of the same version.
