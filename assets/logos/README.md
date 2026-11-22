# Brewery logo library

One round TV badge per brewery, for the draft board. Built 20 Nov 2026.
**Nothing here is live yet.** The board on the TVs doesn't load this folder until
the rollout in `../../logo-rollout/ROLLOUT.md` ships.

## What's here

| Path | What it is |
|---|---|
| `breweries/<brewery>.png` | The badge the TV shows. 256×256, padded so the circle never clips the logo. Named after the brewery as it's typed on the Kegs tab (`old-irving.png`, `3-sheeps.png`, `ope.png`). |
| `originals/<brewery>-original.*` | The untouched source image, in case a badge ever needs remaking. |
| `brewery-logos.json` | **The source of truth.** One entry per brewery: the Kegs-tab name, other spellings (aliases), Untappd name and ID, city, file. |
| `brewery-logos.js` | Generated from the JSON. The board loads this to turn the Brewery column into a logo. Don't hand-edit it. |

275 breweries: every brewery that has ever been on the bar's Untappd menu, draft or cooler
(5,900 menu entries since 2019), plus Cha Cha Tea. The 86 on the Kegs tab or poured on draft
since June 2025 are named exactly as typed on the Kegs tab (`group: draft`); the rest use their
Untappd name (`group: menu history`). If two names ever collide, the draft entry wins.
Logos come from each brewery's Untappd page (Vennture and Cha Cha Tea from the images
already uploaded to your Untappd for Business menu).

A copy of every logo, labeled with the brewery's full name, is in the project's
`Brewery Logos` folder for use outside the board (social posts, emails, signage).

## How the board picks a logo

1. **Icon URL** typed on the Taps tab wins, so a collab or one-off can use a beer label.
2. Otherwise the **Brewery** column is looked up here. Spelling is forgiving: case,
   punctuation, accents and words like *Brewing / Company / Co.* are ignored, and
   aliases catch the rest (`G5` = `G Five`, `Fairstate` = `Fair State`, `Door County` = `DCBC`).
3. No match → the old tier-coloured **initials**. A new brewery never breaks a row;
   it just shows initials until its logo is added.

## Badge style

- Light-background logos sit on the board's warm cream (`#F4EFE6`).
- Logos with their own dark or coloured background keep it (Ope!, Big Grove, The Bruery…).
- Pale line-art that would vanish on cream goes on dark (Vennture).
- Full-bleed art fills the circle edge to edge (Badger State, Brewing Projekt, Tripping Animals).

## Adding a brewery

Easiest: tell Claude "pull a logo for <brewery>". By hand:

```bash
cd "06-draft-board"
python3 scripts/logos/add_logo.py "Brewery Name" "<image URL or file>" --city "City, ST" --alias "Other Spelling"
```

Use the name exactly as it's typed on the Kegs tab. Best image: the logo on the brewery's
untappd.com page (right-click → Copy Image Address). The script saves the original, makes the
badge, updates the JSON, and rebuilds the JS. Needs Python 3 + Pillow (`pip3 install pillow`).

Check which breweries are missing a logo:

```bash
python3 scripts/logos/check_logos.py "Old Irving" "Some New Brewery"
```

## Upgrade candidates

These are wide wordmarks that read small in a circle. They're fine, but a square or round
"icon" version from the brewery would read better from the bar:
McFleshman's, Titletown, Dovetail, Alaskan, Door County (DCBC), Central Waters, Destihl.
Untappd only serves 100px logos; they look sharp at the board's ~79px badge size, but if
you ever want logos bigger (a spotlight slide), ask breweries for press-kit files.
