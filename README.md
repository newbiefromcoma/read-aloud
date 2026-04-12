
<div align="center">
	<img src="img/icon.png" width="128" height="128">
	<br>
	<img src="docs/images/logo-text-trans.png" width="391" height="66">
	<br>
	A <b>Text to Speech Voice Reader</b> extension for your browser!
</div>

<div align="center">
	<a href="https://chromewebstore.google.com/detail/read-aloud-a-text-to-spee/hdhinadidafjejdhmfkjgnolgimiaplp">Chrome Web Store</a> | <a href="https://addons.mozilla.org/en-US/firefox/addon/read-aloud/">Firefox Addon</a> | <a href="https://blog.readaloud.app/">Blog</a> | <a href="https://readaloud.app/">Website</a>
</div>

<br>

<div align="center">
    <br> github stats:
    <img src="https://badgen.net/github/stars/ken107/read-aloud" >
    <img src="https://badgen.net/github/open-issues/ken107/read-aloud" >
    <img src="https://badgen.net/github/open-prs/ken107/read-aloud" >
    <img src="https://badgen.net/github/tag/ken107/read-aloud" >
    <img src="https://badgen.net/github/license/ken107/read-aloud/" >
    <br> chrome web store stats:
    <img src="https://badgen.net/chrome-web-store/users/hdhinadidafjejdhmfkjgnolgimiaplp" >
    <img src="https://badgen.net/chrome-web-store/rating/hdhinadidafjejdhmfkjgnolgimiaplp" >
    <img src="https://badgen.net/chrome-web-store/rating-count/hdhinadidafjejdhmfkjgnolgimiaplp" >
    <img src="https://badgen.net/chrome-web-store/v/hdhinadidafjejdhmfkjgnolgimiaplp" >
    <br> firefox addon stats:
    <img src="https://badgen.net/amo/users/read-aloud" >
    <img src="https://badgen.net/amo/rating/read-aloud" >
    <img src="https://badgen.net/amo/reviews/read-aloud" >
    <img src="https://badgen.net/amo/v/read-aloud" >
</div>

<br>

<div align="center">
	<sub>A little browser extension built with ❤︎ by <a href="https://github.com/ken107">Hai Phan</a> and <a href="https://github.com/ken107/read-aloud/graphs/contributors">contributors</a></sub>
</div>

<hr />

> **This is a fork of [ken107/read-aloud](https://github.com/ken107/read-aloud).**
> It adds a **Speechify-style hover + click-to-seek** feature on top of the original extension.
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

#### How it works — technical summary

Three files were changed/added:

**`js/content/hover-overlay.js`** *(new)* — a self-contained IIFE injected after `html-doc.js`:

1. **Block scan** — walks the DOM for `p, li, h1–h6, blockquote, td, pre, figcaption` and stores outermost readable elements in a `Map` for O(1) lookup.
2. **Cursor → block** — `document.caretRangeFromPoint(x, y)` walks `.parentElement` up until a block is found (same technique as Speechify's `Xe()` function).
3. **Cursor → char offset** — `TreeWalker` accumulates preceding text-node lengths + `range.startOffset` to get the absolute character offset inside the block's `textContent`.
4. **Sentence splitting** — regex `/([.!?]['"»)\]]*)\s+(?=[A-Z"'«(\[])/g` with an abbreviation skip-list (`Dr.`, `Mr.`, `U.S.`, `e.g.`, etc.) to avoid false sentence breaks.
5. **DOM Range** — `TreeWalker` maps `[charStart, charEnd]` back to a real `Range` object.
6. **Line rects** — `Range.getClientRects()` returns one `DOMRect` per visual rendered line.
7. **SVG overlay** — one `<rect rx="3">` per line rect inside a `position:fixed` SVG div; cleared on scroll and repainted on the next `mousemove`.
8. **Click handler** — stores `window.__raSeekTarget = { el, sentenceText }` then sends `stop` → `playTab` to the Read Aloud service worker.

**`js/content/html-doc.js`** *(modified)* — `parse()` checks `window.__raSeekTarget` after building the `toRead` element array:

1. Finds the `toRead` entry that contains the clicked element (handles the common case where html-doc tracks parent containers while hover-overlay tracks `<p>` elements).
2. Slices `toRead` to skip all blocks before the clicked one.
3. Scans **all** extracted text strings for the sentence text and trims from there — this is critical because a multi-block container produces many text chunks and the target sentence may be in any of them.

**`js/content.js`** *(modified)* — the default `getRequireJs()` branch now returns `["js/content/html-doc.js", "js/content/hover-overlay.js"]` so the overlay is injected for all standard HTML pages.

<hr />

## Reviews
>First impressions are super. Natural flowing voice and very helpful for multitasking and also giving my eyes a rest. 

*Giuseppe*

> Thank you so much for this extension. I absolutely swear by it whenever I need to read any large chunk of text. The combination of hearing it in a clear voice (...)  Its fantastic, thank you so much.

*Abi*

> LOVE this extension. I remember better when i hear a story vs reading

*David*

> This is a phenomenal extension. Better than anything else I tryed so far. Simple, easy, customizable (...) I would recommend this whole heartedly to anyone who has dyslexia like me, or any other reasons for not beeing able to read comfortably at all times.

*Merlin*


## Overview
Read Aloud is a Chrome and Firefox extension that uses text-to-speech technology to convert webpage text to audio.&nbsp; It works on a variety of websites, including news sites, blogs, fan fiction, publications, textbooks, school and class websites, online universities and course materials.

Read Aloud is aimed at users who prefer to listen to content instead of reading, people with dyslexia or other learning disabilities, children learning to read, or simply to provide users with alternative way to consume web content.

Read Aloud allows you to select from a variety of text-to-speech voices, including those provided natively by the browser, as well as by text-to-speech cloud service providers such as Google Wavenet, Amazon Polly, IBM Watson, and Microsoft.&nbsp; Some of the cloud-based voices may require additional in-app purchase to enable.

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

- Move your mouse over any paragraph — the sentence under the cursor is highlighted.
- Click the highlighted sentence to start reading from that exact point.
- Click a different sentence mid-playback to jump there instantly.

### Customization

You can change the voice, reading speed, pitch, or enable text highlighting:

1. Click the Read Aloud icon on the [Extensions menu](https://i.imgur.com/KTqFZ3Q.png).
2. Stop any text that may be playing.
3. Click on the Gear icon in the Read Aloud context menu. (It may take a second or two for settings to appear)


### Using Premium Voices
[Using Premium Voices (Google Wavenet & Amazon Polly)](docs/usage/premium-voices.md)


## Installation

### From source (this fork)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.

### Chrome Web Store (upstream)
The original extension is available at the [Chrome Web Store](https://chromewebstore.google.com/detail/read-aloud-a-text-to-spee/hdhinadidafjejdhmfkjgnolgimiaplp).

### Firefox
The original extension is available at [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/read-aloud/).

#### Firefox install from source

1. Create a build directory with `mkdir build`
2. Run `npm run-script package`
3. Extract the resulting zip file. You should see a `manifest.json` which will be used later.
4. In Firefox, first make sure there isn't an existing read-aloud add-on already installed
5. type `about:debugging` in the Address bar and enter.
6. Click on "This Firefox" then click "Load Unpackaged Extension"
7. Select the `manifest.json` file produced earlier.

## Contribute

- Star this GitHub repo :star:
- Post about it on your social media (Twitter / Blogs / Facebook / Instagram etc).
- Leave a positive review on the [Chrome Web Store](https://chromewebstore.google.com/detail/read-aloud-a-text-to-spee/hdhinadidafjejdhmfkjgnolgimiaplp) or [Firefox Addon](https://addons.mozilla.org/en-US/firefox/addon/read-aloud/) pages.
- Create pull requests, submit bugs, suggest new features or documentation updates
	- To do so, go to [this page](https://github.com/ken107/read-aloud/issues) and click the *New issue* button.


## Credits

### Images

 - [Streamline Labs](https://lab.streamlineicons.com/)
 - [Freepik](https://www.freepik.com/free-vector/colorful-memphis-design-background-vector_3893585.htm)

## Upstream

This fork tracks [ken107/read-aloud](https://github.com/ken107/read-aloud).  
Fork-specific changes live on the `feature/speechify-hover-click` branch and are limited to:

```
js/content/hover-overlay.js   (new file)
js/content/html-doc.js        (seek-target logic added to parse())
js/content.js                 (hover-overlay.js added to getRequireJs())
manifest.json                 (version bump 2.22.0 → 2.23.0)
```
