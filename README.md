# Kč Utilities

Gas, electricity and water meter readings for a Czech flat, tracked against the monthly advances (zálohy) so you can see well before the vyúčtování whether you're heading for a refund or a top-up.

**This repository holds only the app's code. It contains no readings, meter numbers, bills or photos.**

## What it does

- **Readings with photo evidence.** Add a reading and a photo of the meter. The photo's camera timestamp, camera model, location (if the phone kept it) and a SHA-256 fingerprint of the original file are saved with it. The app warns when the photo date doesn't match the reading date, when a reading is lower than the last one, or when it jumps far more than expected (the cracked gas display once gave 1,529 instead of 1,589).
- **Running balance.** Advances paid since the start of the billing year against the cost of what the meters show, at all-in prices (supplier plus distribution, incl. VAT).
- **Bill forecast.** The projected settlement at the end of the billing year, per utility and in total, updated with every reading. Gas follows a monthly heating curve fitted to your readings; electricity and water use your recent daily rate.
- **Advance check.** The gas page compares the meter with the central, cold and ČEZ-advance tracks and suggests an advance; electricity and water say whether the current advance is about right.
- **Bill checker.** Enter each vyúčtování and it is checked against your own readings: end reading, usage, kWh per m³, cost and whether the balance adds up.
- **Leak test.** Two timed readings a few hours apart with nothing running show any flow.
- **Settings** for every price, band, advance and the heating split. GasNet distribution rates reset each January.

## How your data is protected

- Everything is encrypted on the device before it is stored or sent anywhere. A random 256-bit data key encrypts your readings, bills, settings and photos with AES-GCM. That key is itself encrypted with a key derived from your passphrase (PBKDF2-SHA256, 600,000 rounds).
- Sync stores only the encrypted data (`vault.json`) and encrypted photos (`img/*.json`) in a **private** repository you own. The app refuses to sync with a public repository.
- The GitHub access token is kept inside this device's encrypted copy. It is never synced or put in backups.
- The page only talks to its own address and `api.github.com` (enforced by its Content Security Policy). Fonts are bundled. There is no analytics and no third-party code.
- There is no passphrase reset. Keep the passphrase in a password manager.

## Install on your phone

The app is at **https://jonovanvanyken-lab.github.io/Kc-Utilities/**

- **iPhone:** open the link in Safari or Chrome → Share → **Add to Home Screen**.
- **Android:** open the link in Chrome → ⋮ menu → **Install app**.

Open it from the home-screen icon and choose **Start on this device**. To bring in the readings kept on the Claude page, use **Import from the Claude page** with the export file, then delete that file.

## Sync between phone and laptop (optional)

1. Create a **private** repository, for example `Kc-Utilities-Data`.
2. Make a fine-grained personal access token (GitHub → Settings → Developer settings → Fine-grained tokens) limited to that one repository, with **Contents: Read and write**.
3. In the app: **Settings → Sync between devices**, enter the repository and token, and connect.
4. On the second device choose **Join one that's already synced** and use the same passphrase.

## Backups

**Settings → Backups and import** saves an encrypted backup file that opens with your passphrase, with or without photos. Keep it somewhere safe, such as iCloud Drive. Never upload backups or exports to this repository.

## Updating the app

Push the changed files. The app fetches its own code fresh whenever it opens online; **Settings → Check for a new version** forces it. When `app.js` or `app.css` change, bump the `?v=` in `index.html` and `sw.js` and the `VERSION` in `sw.js`.

## Credits

Typefaces Barlow, Barlow Condensed and Martian Mono, under the SIL Open Font License (licences in `fonts/`).
