# Ledger

A local-first, multi-currency payment ledger. Everything runs client-side —
SQLite compiled to WebAssembly (sql.js) is the "database," and it's saved to
the browser's IndexedDB after every change. No server, no account, no data
ever leaves the device.

## Running it

**On your PC:** open `index.html` directly, or serve the folder with any
static file server (e.g. `python3 -m http.server`) for the PWA install
prompt and offline caching to work (those require `http://localhost` or
`https://`, not `file://`).

**On a phone:** put this folder on a small web host (GitHub Pages, Netlify,
Cloudflare Pages, or your own PC's local server on the same Wi-Fi) and open
the URL in Chrome (Android) or Safari (iOS). Then:
- **Android/Chrome:** menu → "Add to Home screen" (or a banner will offer it).
- **iOS/Safari:** Share button → "Add to Home Screen."

That installs a real home-screen icon that opens full-screen, with no
browser chrome, and keeps working offline after the first load.

## What changed from the original

- **Mobile layout:** the nav moves to a fixed bottom tab bar on phones, all
  tap targets are enlarged, inputs are 16px (stops iOS auto-zoom), and the
  Data tab's row editor stacks vertically for easy one-thumb editing.
- **Backup export/import, fixed for Android/Google:** exporting now tries
  the Web Share API first, so "Export backup" can hand the `.sqlite` file
  straight to Google Drive, Gmail, Files, etc., with a normal download as
  the fallback everywhere else. Importing validates the file's SQLite magic
  bytes up front, so picking the wrong file gives a clear message instead of
  a cryptic error.
- **PWA support:** `manifest.json` + `service-worker.js` make the app
  installable to the home screen and fully usable offline.
- **Dashboard:** the per-currency breakdown under each week's total is now
  always visible (previously hover-only, which phones can't do). A new
  "Clients" toggle unfolds a per-client breakdown for that week (grouped
  case-insensitively, e.g. "Acme" and "acme" merge into one line).
- **Tap-to-view tooltips:** the Data tab's weekly total and the dashboard's
  daily bars now respond to a tap, not just a mouse hover.
- **Entry details + edit history:** tapping any row in the Data tab (not the
  edit pencil) opens a popup with the client, amounts, and the exact
  creation timestamp, plus a log of every saved edit to that row (old value
  → new value, with its own timestamp).
- **Bug fix:** "Add row" previously failed to open the new row for editing
  (a sql.js quirk reset the tracked row ID before it was read). Fixed.
- **Missing file restored:** `js/i18n.js` (English/Russian/Turkish strings)
  didn't exist in the project at all — the app couldn't have run without it.

## Compiling to an Android APK

See the chat message this was delivered with for the full writeup. Short
version: this app is 100% static (no backend), which makes **Capacitor**
the best fit — it packages these exact files into a native Android project
that you build with Android Studio. That step needs internet access and the
Android SDK, which this sandboxed environment doesn't have, so it isn't
done here — but the app is already structured (relative paths, a proper
manifest, no code changes needed) to drop straight into a Capacitor project.
