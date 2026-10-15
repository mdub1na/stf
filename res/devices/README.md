# Device catalogue artwork

This directory contains original, generated model-representative illustrations,
created with the built-in imagegen tool on 2026-10-16. They are not manufacturer
photographs or screenshots from connected phones. Wallpapers are illustrative;
the artwork is intended for identifying devices, not measuring their hardware.
The prompts and final background-extraction instructions are in `prompts.json`.
These project assets are supplied under the repository's Apache-2.0 license.
The separate legacy device-db assets retain their existing license and notices.

| Model | Hardware identifiers | Asset |
| --- | --- | --- |
| iPhone 16 Plus | Apple / iOS / iPhone17,4 | iphone-16-plus-v1.webp |
| Galaxy A55 5G | Samsung / Android / SM-A556E | galaxy-a55-v1.webp |
| Galaxy Z Fold4 (closed) | Samsung / Android / SM-F936B | galaxy-z-fold4-v1.webp |
| Mi A2 | Xiaomi / Android / Mi A2 | mi-a2-v1.webp |
| Redmi Note 13 | Xiaomi or Redmi / Android / 23124RA7EO; product sapphiren | redmi-note-13-v1.webp |
| Huawei nova 12i | Huawei / Android / CTR-L81; product HWCTRN-Q | huawei-nova-12i-v1.webp |

The nova 12i identity was confirmed by the owner of the connected device.
Both A55 phones use the same model asset. Regional variants are added explicitly;
the resolver does not guess a nearby model from a partial identifier.

## Serving and maintenance

`lib/util/device-catalog.ts` resolves these entries before the legacy device-db.
It sets the presentation name and image without replacing hardware identifiers,
measured CPU/RAM or display dimensions. Unknown devices use the transparent
`generic-phone-v1.svg`; existing legacy/custom images are retained.

The app serves this directory first at `/static/app/devices`, then falls through
to the legacy package. The API and WebSocket services must run the catalogue
revision as well as the app so initial lists and live updates agree. No remote
image host is contacted at runtime.

Each WebP preserves alpha and is stored at three resolutions: `icon/x24` (48 px
canvas height), `icon/x120` (240 px) and `photo/x800` (800 px). The smaller two
support high-density screens. The SVG generic is shared at all three paths.
The filenames are versioned because static responses are cached for 30 days.
On artwork changes, increment the filename version and update the catalogue.

For a new model, add exact manufacturer/platform/model or explicit product
aliases, all three image sizes and provenance/prompt information. Run the unit
and component suites, check the packed npm artifact includes the assets, and
inspect the image on both light and dark backgrounds. A failed image request
falls back through the shared `DeviceImage` component.
