# Admin console — tabs

**Date:** 2026-11-22
**Status:** approved, building

## Intent

The admin console is one long scroll of fifteen flat sections, and the work
that belongs together is scattered across it: building a channel means moving
between six separate sections (pick one → add content → add commercials → build
from the library → draft → on air), and the theme sits below backup, which
sits above all of it. The console has grown by accretion and needs organising
before any one part of it can be made good.

This is a reorganisation, not a rewrite. Every feature that exists today
still exists after the move, in a tab where it belongs.

## Goals

- Four tabs: **Site**, **Transcode**, **Channels**, **On air**.
- Every current feature accounted for, in one place, with nothing dropped.
- The channel-building flow reads as one flow, not six sections.
- The transcode tab shows what the cache is doing, not just five numbers.
- Members: a list, a way to add one, and a way to reset a password — with no
  way to see a current password, because none is kept in a readable form.
- The old console keeps working until the new one is ready to swap.

## Non-goals

- No new features beyond the live transcode view.
- No change to the server's admin API shape, except the one new read-only
  endpoint the transcode view needs.
- No visual redesign of the TV page.

## The shape

```
admin.htm
┌─ SITE ──────────────────────────────────────────────────────────────┐
│  site name · coffee & patreon links · theme · footer boxes ·       │
│  site password · members (list / add / reset) · chat & effects ·    │
│  backup & move                                                       │
├─ TRANSCODE ─────────────────────────────────────────────────────────┐
│  output height · skip limit · cache size · look-ahead · live cap ·   │
│  pre-convert on/off — and what the cache is doing right now         │
├─ CHANNELS ──────────────────────────────────────────────────────────┤
│  the channel list  │  the selected channel: content, commercials,    │
│  (add/edit/delete) │  the draft, publish, and what it is running     │
├─ ON AIR ─────────────────────────────────────────────────────────────┤
│  every channel at once: what's playing now and next, shift & jump    │
└──────────────────────────────────────────────────────────────────────┘
```

### Decisions

- **On air is a fourth tab**, not a section inside Channels. It is a
  monitoring view of every channel at once — the thing you want open on a
  second screen while you build. The Channels tab shows a one-line "on air
  now" for the channel being worked on; the shift and jump controls live only
  on the On air tab, so they are never in two places at once.
- **The On air tab shows now and next per channel — no guide grid.** The TV
  page has the guide; the console does not need a second implementation of it.
- **Channels is master-and-detail**: the channel list on the left, the
  selected channel's build flow on the right. Picking a channel is the first
  thing you do; it should not be a dropdown you have to keep re-opening.
- **Transcode gets a live view**: what is converted, what is converting now,
  what is flagged broken, and how much disk the cache is using. This is one
  new read-only endpoint.
- **Chat & effects and backup & move live on Site** — site-wide housekeeping.
  A fourth tab for two things felt thin, and five tabs is one too many.

## What moves where — the checklist

Every section of the current `admin.html`, and where it goes. Nothing is
dropped; this list is the acceptance test.

| Today | Goes to |
|---|---|
| login / auth warning / sign out | unchanged, above the tabs |
| SITE (name, coffee, patreon) | Site |
| FOOTER BOXES | Site |
| SITE ACCESS (site password) | Site |
| CHAT & EFFECTS (effects on/off, rate limit, chat mode, viewer count) | Site |
| CHAT USERS (members) | Site — becomes a list with add + reset |
| THEME (presets, colours, reset) | Site |
| BACKUP & MOVE (backup now, export, import) | Site |
| TRANSCODE (height, skip, cache, look-ahead, live cap, pre-convert) | Transcode |
| — | Transcode: **new** live cache view |
| CHANNEL (list, add, edit, delete, shuffle, auto-generate) | Channels, left column |
| ADD CONTENT (single item, folder, archive.org link) | Channels, right column |
| ADD COMMERCIAL (generated) | Channels, right column |
| BUILD A CHANNEL FROM YOUR LIBRARY (the wizard) | Channels, right column |
| DRAFT LINEUP | Channels, right column |
| publish / shuffle from the draft | Channels, right column |
| ON AIR — ALL CHANNELS (per channel, shift & jump) | On air |

### Drafts are kept per channel

Today `selectChannel()` replaces one global draft with the published items of
whichever channel you pick, so a stray click loses what was just added. With
the channel list sitting permanently beside the editing column, that is a trap.
The new Channels tab keeps a draft per channel id: switch away and back, and
your half-built lineup is still there.

### Members

The server stores `username -> scrypt hash`. It never holds a readable
password, so there is nothing to show and nothing to leak. Adding a member
writes a hash; adding a member with an existing name overwrites that hash,
which is a reset. The new UI makes that explicit rather than accidental:

- the list of members, each with a **reset password** action
- a reset opens a small form for the new password; the current one is never
  asked for and never shown
- "add member" and "reset password" are the same form, differing only in
  whether the name is new

## New server work

One read-only endpoint, so the transcode tab can show the cache:

```
GET /api/admin/transcodes
→ { counts, bytes, diskBytes, cacheBytes, queue, total,
    list: [ { src, status, bytes, height, err, at } ] }
```

- `counts` — how many entries are in each state (ready / working / pending /
  bad / too_large).
- `bytes` — the sum of the converted mp4s' sizes. This is the number eviction
  enforces against the cache limit, so it is what "how full is the cache" means.
- `diskBytes` — the real size of `data/transcodes` on disk, which also counts
  the in-flight `.part` files and any orphans the store no longer lists. The
  two differ, and showing only one of them would lie about the disk.
- `queue` — how many sources are waiting for one of the two conversion slots.
  They are not in the store yet, so a file-based view cannot show them.
- `height` — the *source* height, which is not the output height; the panel
  labels it as such, because next to a 480p output setting a 1080 reading
  looks wrong otherwise.

The endpoint is read-only and changes nothing about how transcoding works.

## The fork, and the swap

- Work happens in `public/admin.htm`, a copy of `admin.html` with the tabs.
  `admin.html` keeps working untouched the whole time.
- `admin.htm` needs one line in the server's site gate: the gate exempts
  `/admin.html` from the site password, and `admin.htm` needs the same
  exemption or the page is unreachable when a site password is set.
- The admin API is already password-gated server-side, so the fork inherits
  that with no extra work.
- When it is good, `admin.htm` replaces `admin.html` and the old file goes —
  the console keeps the same URL, so the README's links, bookmarks and
  `verify.js` all keep working. The site's gate exemption for `/admin.htm`
  exists only while the fork is in use.

## Testing

- `scripts/verify.js` is a plain fetch script with no DOM and no browser in
  the image, so it checks the page at the markup level: the new page responds,
  contains the four panels and their key ids, the old `/admin.html` still
  responds, and the new endpoint returns the shape above. No new dependency.
- A browser pass over each tab, done by hand: every input saves, every button
  does what it says, the draft survives a tab switch and a channel switch.
- Locally first, on the demo channel, then on Platti against the real library.

## What is left to the builder

- The tab shell and the CSS for it, in the app's existing visual language
  (purple panel, amber borders, monospace) — no new colour system.
- The order the controls appear in, within each tab.
- How the live transcode view refreshes (on a timer, or on demand).

## What it became

The console shipped with eight tabs, in this order: **Channels · On air ·
Transcode · Flags · Site · Members & Chat · Backup · Info**. The four the first
draft asked for are all there; Members & Chat, Backup, Flags and Info were added
as the console was used and the seams showed.

- The Site tab holds the site itself, the access password, the theme and the
  footer boxes. Chat moved to Members & Chat, where the Discord integration will
  live when there is one. Backup moved out on its own, because it is a
  different kind of thing from a setting.
- Channels is master-and-detail: the channel list on the left, and on the right
  what the selected channel actually holds, show by show, file by file.
- Flags is a tab of its own: every file the cache has given up on, across every
  channel, with the way to fix each one and a record of what was taken out and
  why.
- Info is the small tab: version, uptime, memory, what is mounted and how full
  it is, the links, and a thank you.

The fork is over: `public/admin.htm` was the working copy and is now
`public/admin.html`, with `/admin.htm` redirecting to it.
