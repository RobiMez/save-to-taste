# Save to taste

A Firefox extension for keeping the visuals you like. Right-click an image or a video on any page and it goes to your taste server, on top of this week, with a link back to where it came from.

A small card opens by the cursor while it saves, with a box for why you liked it.

I use it to fill [robi.work/taste](https://www.robi.work/taste), a week at a time.

The extension is only half of it, though. It needs a server to save to, and you run that yourself. [The server](#the-server) lists the three routes it calls.

## What it does when you right-click

- **Images** get fetched at the biggest size it can find. A Pinterest pin comes from `/originals/` instead of the 736px preview, and a Cosmos image comes without its resize parameters.
- **Videos** with a real file get downloaded. Streamed ones ( Pinterest's play from a `blob:` address ) get recorded as they play, from the start, for up to a minute, as webm. A 12 second clip takes 12 seconds to save.
- **The credit** is the item's own page when the image sits inside a link to one ( a pin on a board, an element in a Cosmos grid ). Otherwise it's the page you're on.
- **Overlays** don't stop it. Some sites lay a see-through div over their images ( Cosmos's viewer does ), and Firefox won't show its image menu through it. `page.js` finds the picture or video under the cursor, and the menu offers to save it anyway.

It sends the file, the page it came from and your note to your server, and nothing anywhere else. The token stays in the background script, so page scripts never see it.

## Installing it

Firefox only, version 142 or newer. It leans on Firefox's `menus` API to find what you right-clicked, and Chrome doesn't have one.

It isn't listed on addons.mozilla.org, so there are two ways in.

**To try it**, run it in a throwaway Firefox profile:

```sh
pnpm install
pnpm start
```

Or open `about:debugging#/runtime/this-firefox`, choose Load Temporary Add-on and pick `manifest.json`. Either way it's gone when Firefox closes.

**To keep it**, sign your own copy. Firefox only keeps signed extensions installed, and Mozilla signs unlisted ones for free:

1. Change `browser_specific_settings.gecko.id` in `manifest.json` to an ID of your own, like `save-to-taste@yourdomain.com`. Mozilla ties an ID to the account that signed it first, so mine won't sign for you.
2. Make API keys at [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/).
3. Run `WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… pnpm sign`. The signed `.xpi` lands in `dist/`. Open it in Firefox to install.

Bump `version` in `manifest.json` before each signing. Mozilla won't sign the same version twice.

Then click the toolbar button, paste your server's address and a token from it, and hit Save. It should say Connected.

## The server

Everything goes to the one address you set, with the token as `Authorization: Bearer <token>`. A server needs three routes under that address.

Mine runs robi.work/taste and lives in my site's repo, so it isn't here.

### `GET /ext/ping`

The settings page calls it to check the token. A 200 means connected, and a 401 means the token's wrong.

### `POST /ext/entries`

One saved image or video. The body is the raw file and `Content-Type` is whatever the site served it as, so check the bytes rather than trusting it. Mine takes JPEG, PNG, GIF, WebP and AVIF images, and MP4 or WebM video.

The query string has:

| Parameter         | What it is                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `week`            | The Monday of the saver's local week, like `2026-11-16`. Mine files entries by week. Ignore it if yours doesn't. |
| `source`          | The page it came from. Left out when there's no web page to credit.                                              |
| `width`, `height` | The video's size in pixels, measured in the page. Only sent for videos.                                          |

Answer `201` with the week and the new entry's ID:

```json
{ "week": "2026-11-16", "entry": { "id": 42 } }
```

The card shows "Saved to taste, week of Nov 16" from `week`, and sends the note against `entry.id`.

A recorded video is at most a minute of 6 Mbps WebM, so about 45 MB. Mine allows 60 MB for a video and 30 MB for an image.

### `PATCH /ext/entries/:id`

The note from the card, as `{ "note": "…" }`. Mine only lets a token write notes on entries that same token added, so a leaked token can't rewrite the rest of the page.

### Errors

Answer anything that isn't a 2xx with `{ "error": "…" }` and the card shows that text by the cursor.

### Tokens

A token can write to your page, so treat it like a password. Mine are random and stored hashed, and they only work on these three routes. Mine also sends `Access-Control-Allow-Origin: *` on them and lets the `Authorization` and `Content-Type` headers through.

## Working on it

There's no build step. Firefox loads the files as they are:

- `background.js` owns the menu, fetches or records what you clicked, and talks to the server.
- `page.js` runs in every page. It remembers where you right-clicked and draws the card there.
- `options.html` and `options.js` are the settings page.

`pnpm start` opens Firefox with it loaded and reloads it when a file changes. `pnpm lint` runs Mozilla's validator, the same one addons.mozilla.org runs on upload. `pnpm format` runs Prettier.

## What's left

- A server you can run yourself. Mine is tied to my site.
- Saving with no server at all, into a folder with the note beside the file.
- Recorded videos are WebM ( VP8 or VP9 ), which older iPhones won't play.
- A recording always starts from the beginning and stops at a minute.
- Chrome. It'd need another way to find what was right-clicked.
- A screenshot for this README.

## License

MIT, see [LICENSE](LICENSE).
