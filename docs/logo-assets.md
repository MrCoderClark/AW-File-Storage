# Logo assets — America Works state logos

How the per-state America Works logos work, and the transparency conversions done on 2026-09-02.

## Two places logos live (this matters)

There are **two** sources of state logos, and the database one wins:

1. **Built-in fallback files** — `public/logos/<state>.png` (`ca.png`, `dc.png`, `md.png`, `ny.png`, `wi.png`, `pa.png`, plus `general.png`). Served by the app Worker as static assets. Resolved in code by `logoForState()` in `src/lib/signature-brand.ts`.
2. **Admin-uploaded logos** — rows in the `org_social_link` table (`logo_url` column), managed in **Settings → Regional social links**, with the image stored in the R2 public bucket at `logos/<org-id>/<STATE>.png` (or `.jpg`). Resolved by `getStateLogoUrl()` in `src/server/social-links.ts`.

**Resolution order (signature page and the public card landing, spec 0008/0009):**
`getStateLogoUrl(org, state)` returns, in order: the exact-state DB row's `logo_url` → the org-wide `"*"` DB row's `logo_url` → `null`. Only when it returns `null` does the code fall back to the built-in `public/logos/<state>.png`.

**Consequence:** if an org has uploaded any logos (an exact-state row **or** an org-wide `"*"` default), the built-in `public/logos/*.png` files are **never used** for that org's landing/signature. The production org (`01a0493f-…`) has uploaded `"*"`, `NY`, `TN`, `WI`, and `PA`, so its cards render the DB logos, not the files in `public/logos/`.

## What was changed on 2026-09-02

Two built-in files had a solid **white background**; every other built-in logo was already transparent. Converted both to a transparent background so they match `dc.png`:

- `public/logos/ca.png` — was RGB, white background → now RGBA, transparent.
- `public/logos/pa.png` — user converted `pa.jpg` → `pa.png` (RGB, white background); converted to RGBA, transparent. The stale `pa.jpg` was removed.

Background check across all built-in logos before/after:

| File | Before | After |
|---|---|---|
| ca.png | white (opaque RGB) | transparent (RGBA) |
| pa.png | white (opaque RGB, from a converted jpg) | transparent (RGBA) |
| dc, md, ny, wi, general | already transparent | unchanged |

### Method

Used `sharp` (already a dev dependency) with a **min-channel feather**: a pixel's alpha is derived from the minimum of its R/G/B. Near-white pixels become fully transparent, colored pixels stay fully opaque, and the narrow band between them is ramped so edges stay smooth (no hard white halo). White is `[255,254,251]`-ish, so any real color (red gears, blue/purple stars, gray text) has at least one low channel and is kept. The star centers are white in the source and become transparent — exactly as in `dc.png`.

Thresholds: `HI = 246` (min-channel ≥ HI → alpha 0), `LO = 232` (min-channel ≤ LO → alpha 255), linear ramp between.

### Commands run

Inspect a logo's background (channels, alpha, corner pixel):

```bash
node -e "
const sharp=require('sharp');
(async()=>{
  const m = await sharp('public/logos/ca.png').metadata();
  const { data, info } = await sharp('public/logos/ca.png').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const c=[data[0],data[1],data[2],data[3]];
  console.log('channels='+m.channels,'hasAlpha='+m.hasAlpha, m.width+'x'+m.height, 'corner='+JSON.stringify(c));
})();
"
```

Convert white background → transparent (run per file, swapping `ca`/`pa`):

```bash
node -e "
const sharp = require('sharp');
(async () => {
  const { data, info } = await sharp('public/logos/ca.png').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  const HI = 246, LO = 232; // min-channel feather
  for (let i = 0; i < out.length; i += info.channels) {
    const t = Math.min(out[i], out[i+1], out[i+2]);
    out[i+3] = t >= HI ? 0 : t <= LO ? 255 : Math.round(255 * (HI - t) / (HI - LO));
  }
  await sharp(out, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png().toFile('public/logos/ca.tmp.png');
})();
"
mv public/logos/ca.tmp.png public/logos/ca.png
```

Then for PA (and cleanup of the stale jpg):

```bash
# same node script with 'ca' → 'pa'
mv public/logos/pa.tmp.png public/logos/pa.png
rm -f public/logos/pa.jpg
```

Verify the result (corner alpha 0, colored content preserved):

```bash
node -e "
const sharp=require('sharp');
(async()=>{
  const { data, info } = await sharp('public/logos/ca.png').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const c=[data[0],data[1],data[2],data[3]];
  let opaque=0,transp=0; for(let i=0;i<data.length;i+=info.channels){const a=data[i+3]; if(a===0)transp++; else if(a===255)opaque++;}
  console.log('corner='+JSON.stringify(c),'opaque='+opaque,'transparent='+transp);
})();
"
```

## Live-logo audit (2026-09-02)

Checked the production org's DB-uploaded logos directly from R2 (`https://contacts.awvcard.com/logos/<org>/…`):

| State (DB / R2) | Size | Background |
|---|---|---|
| `"*"` default (`*.png`) | 396×300 | transparent |
| `NY.png` | 133×100 | transparent |
| `PA.jpg` | 1446×1064 | **white (opaque)** |

So on the live landing/signature, only **PA** shows a white background (its uploaded `PA.jpg`). CA cards have no CA row, so they use the transparent `"*"` default — they already look correct after the spec-0008 landing-logo fix. **Action for PA:** re-upload the transparent `pa.png` via **Settings → Regional social links → PA** (this replaces the R2 object and updates `org_social_link.logo_url`). Converting `public/logos/pa.png` alone does not fix it, because PA has a DB row that wins.

Command used to audit a live DB logo:

```bash
curl -s -o /tmp/PA.jpg "https://contacts.awvcard.com/logos/<org-id>/PA.jpg"
node -e "const s=require('sharp');s('/tmp/PA.jpg').metadata().then(m=>console.log(m.width+'x'+m.height,'hasAlpha='+m.hasAlpha))"
```

## Important: the built-in file change alone may not change the live landing/signature

Because the production org uses DB-uploaded logos (see resolution order above), converting the built-in `public/logos/*.png` files does **not** change what appears on that org's card landing pages or signatures. To make the **live** logos transparent, the transparent images must replace the DB-uploaded ones:

- **Preferred:** in the app, **Settings → Regional social links**, upload the transparent PNG for each state (and the `"*"` default). This writes a new object to `logos/<org>/<STATE>.png` and updates `org_social_link.logo_url`.
- The built-in `public/logos/*.png` only render for an org that has **no** uploaded logos at all (not even a `"*"` default).

## Replacing a logo and stale R2 files

`uploadStateLogo` (`src/server/social-links.ts`) writes to `logos/<org>/<STATE>.<ext>` (ext from the file type) and updates the DB, but does **not** delete the previous object.

- **Same extension** (PNG replacing PNG): overwrites the same key. No stale file.
- **Extension change** (e.g. PA `.jpg` → `.png`): the new object lands at a different key; the old one is orphaned in R2 (unreferenced by the DB).

On 2026-09-02, after converting PA from jpg to png and re-uploading, the old `logos/<org>/PA.jpg` was left orphaned (every other state's `.jpg` variant returned 404, so PA was the only one). Removed with:

```bash
npx wrangler r2 object delete "aw-files-public/logos/<org-id>/PA.jpg" --remote
```

Auditing for orphans (probe the `.jpg`/`.png` variants; the DB `logo_url` is the source of truth for what's referenced):

```bash
npx wrangler d1 execute aw-file-storage --remote --command "SELECT state, logo_url FROM org_social_link WHERE logo_url IS NOT NULL;"
curl -s -o /dev/null -w "%{http_code}\n" "https://contacts.awvcard.com/logos/<org-id>/PA.jpg"
```

**Prevention (done):** `uploadStateLogo` now deletes the previous object when the key changes (the file type changed), guarded like `clearStateLogo` so it never removes an image another state reuses. So from now on a png↔jpg swap cleans up after itself; only the pre-existing `PA.jpg` needed the one-off manual delete above.

## Notes / follow-ups

- `pa.png` is 1446×1064 (~750 KB), much larger than the other built-in logos (~16–48 KB). Optional: downscale to ~300 px wide to shrink it, since it only ever displays small.
- The original `ca.png` (white background) is preserved in git history if a revert is ever needed.
