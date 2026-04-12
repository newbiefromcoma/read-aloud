
<div align="center">
	<img src="img/icon.png" width="128" height="128">
	<br>
	<img src="docs/images/logo-text-trans.png" width="391" height="66">
	<br>
	A <b>Text to Speech Voice Reader</b> extension for Chrome!
</div>

<br>

<hr />

> **This is a fork of [ken107/read-aloud](https://github.com/ken107/read-aloud).**
> It adds **Speechify-style hover sentence preview, click-to-seek, and real-time playback highlight** on top of the original extension.
> All original functionality is preserved unchanged.

<hr />

## What's new in this fork

### Hover sentence preview + click-to-seek (v2.23.0)

Inspired by how Speechify highlights text as you hover over it, this fork adds the same interaction model to Read Aloud:

| Interaction | Behaviour |
|-------------|-----------|
| **Hover** over any paragraph | The sentence under the cursor is highlighted with a soft purple rounded rectangle, line by line |
| **Click** any sentence | Read Aloud stops whatever it was reading and starts reading from exactly that sentence |
| **Move** to another sentence while hovering | The highlight updates in real time (32 ms throttle, ~30 fps) |
| **Scroll** | The hover highlight clears automatically; it reappears on the next mouse move |

This works on all standard HTML pages (articles, blogs, news sites, docs). It is not active on PDF viewer, Google Docs, Kindle, or other special-purpose content handlers.

### Real-time playback sentence highlight (v2.24.0)

While Read Aloud is speaking, the sentence currently being read is highlighted with an amber rounded rectangle — similar to how Speechify tracks the reader's position through the page.

| Behaviour | Detail |
|-----------|--------|
| **Amber highlight** follows playback | The currently-spoken sentence is highlighted with a warm amber glow, line by line |
| **Auto-scroll** | If the highlighted sentence scrolls out of view, the page smoothly centres on it |
| **Scroll repositioning** | Scrolling by hand instantly redraws the amber highlight at its new screen position (no 300 ms wait) |
| **Hover coexists** | The purple hover preview and the amber playback highlight are on separate SVG layers; both can be visible simultaneously |
| **Clears on stop/pause** | The amber overlay disappears as soon as playback stops or pauses |

#### How it works — technical summary

Four files were changed/added:

**`js/content/hover-overlay.js`** *(new)* — a self-contained IIFE injected after `html-doc.js`:

1. **Block scan** — walks the DOM for `p, li, h1–h6, blockquote, td, pre, figcaption` and stores outermost readable elements in a `Map` for O(1) lookup.
2. **Cursor → block** — `document.caretRangeFromPoint(x, y)` walks `.parentElement` up until a block is found (same technique as Speechify's `Xe()` function).
3. **Cursor → char offset** — `TreeWalker` accumulates preceding text-node lengths + `range.startOffset` to get the absolute character offset inside the block's `textContent`.
4. **Sentence splitting** — regex `/([.!?]['"»)\]]*)\s+(?=[A-Z"'«(\[])/g` with an abbreviation skip-list (`Dr.`, `Mr.`, `U.S.`, `e.g.`, etc.) to avoid false sentence breaks.
5. **DOM Range** — `TreeWalker` maps `[charStart, charEnd]` back to a real `Range` object.
6. **Line rects** — `Range.getClientRects()` returns one `DOMRect` per visual rendered line.
7. **Two SVG overlay layers** — a purple layer (z:2147483646) for hover preview and an amber layer (z:2147483644) for playback; one `<rect rx="3">` per line rect inside each `position:fixed` SVG div.
8. **Click handler** — stores `window.__raSeekTarget = { el, sentenceText }` then sends `stop` → `playTab` to the Read Aloud service worker.
9. **Playback polling** — a 300 ms `setInterval` calls `getPlaybackState` on the service worker; uses a change-key (`"index:text"`) so DOM repaints only happen when the spoken sentence actually changes.
10. **Stored Range** — the active `Range` is persisted between polls so scroll events can immediately repaint the amber overlay at the new screen position without waiting for the next poll.
11. **Auto-scroll** — when the highlighted sentence is outside the viewport, `scrollIntoView({ behavior: 'smooth', block: 'center' })` re-centres the page.

**`js/content/html-doc.js`** *(modified)* — `parse()` checks `window.__raSeekTarget` after building the `toRead` element array:

1. Finds the `toRead` entry that contains the clicked element (handles the common case where html-doc tracks parent containers while hover-overlay tracks `<p>` elements).
2. Slices `toRead` to skip all blocks before the clicked one.
3. Scans **all** extracted text strings for the sentence text and trims from there — this is critical because a multi-block container produces many text chunks and the target sentence may be in any of them.

**`js/content.js`** *(modified)* — the default `getRequireJs()` branch now returns `["js/content/html-doc.js", "js/content/hover-overlay.js"]` so the overlay is injected for all standard HTML pages.

**`manifest.json`** *(modified)* — version bumped `2.22.0` → `2.24.0`.

<hr />

## Overview

Read Aloud is a Chrome extension that uses text-to-speech technology to convert webpage text to audio. It works on a variety of websites, including news sites, blogs, fan fiction, publications, textbooks, and course materials.

It supports a variety of voices, including those provided natively by the browser as well as cloud providers such as Google Wavenet, Amazon Polly, IBM Watson, and Microsoft.

## Basic Usage

### Extension Button
<img src="docs/images/demo-extension-button.gif">

### Right Click Menu
<img src="docs/images/demo-right-click.gif">


## Advanced Usage

### Shortcuts

```yaml
ALT/Option + P           : Play/Pause
ALT/Option + O           : Stop
ALT/Option + Comma       : Rewind
ALT/Option + Period      : Forward
```

### Hover & Click to Seek

After pressing Play at least once on a page (so Read Aloud's content script is active):

- Move your mouse over any paragraph — the sentence under the cursor is highlighted in purple.
- Click the highlighted sentence to start reading from that exact point.
- Click a different sentence mid-playback to jump there instantly.

### Playback Highlight

While reading is active, the sentence currently being spoken is highlighted in amber:

- The amber highlight follows Read Aloud sentence by sentence as playback progresses.
- If the highlighted sentence scrolls out of view, the page auto-scrolls to keep it visible.
- Scrolling manually instantly repositions the amber overlay at its new screen position.

### Customization

You can change the voice, reading speed, pitch, or enable text highlighting:

1. Click the Read Aloud icon on the [Extensions menu](https://i.imgur.com/KTqFZ3Q.png).
2. Stop any text that may be playing.
3. Click on the Gear icon in the Read Aloud context menu.


### Using Premium Voices
[Using Premium Voices (Google Wavenet & Amazon Polly)](docs/usage/premium-voices.md)


## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.

## Upstream

This fork is based on [ken107/read-aloud](https://github.com/ken107/read-aloud).  
Fork-specific changes:

```
js/content/hover-overlay.js   (new file — hover preview, click-to-seek, playback highlight)
js/content/html-doc.js        (seek-target logic added to parse())
js/content.js                 (hover-overlay.js added to getRequireJs())
manifest.json                 (version bump 2.22.0 → 2.24.0)
```
