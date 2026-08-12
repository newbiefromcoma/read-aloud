// Read Aloud — Speechify-style hover + click overlay + playback highlight
//
// Three layers:
//
//   1. HOVER PREVIEW (z:2147483646)
//      mousemove (32 ms throttle) → blockFromPoint → charOffsetInBlock →
//      sentenceAt → createRangeForChars → getClientRects → per-line SVG <rect>
//
//   2. CLICK-TO-SEEK
//      pointerup → same pipeline →
//      window.__raSeekTarget = {el, sentenceText} → brapi stop → brapi playTab
//      (html-doc.js consumes __raSeekTarget)
//
//   3. PLAYBACK HIGHLIGHT (z:2147483644)
//      poll getPlaybackState → texts[position.index] → findTextInBlocks →
//      createRangeForChars → per-line SVG <rect>.  The Range is stored so scroll
//      repositions without waiting for the next poll.  Follows the reading
//      position, and stands down while the user is reading somewhere else.
//
// Sentence splitting comes from js/punctuator.js — the same splitter the speech
// engine uses. A private copy would drift, and since a click resolves to a
// sentence and then asks the engine to start there, drift means reading starts in
// the wrong place.

(function () {
  'use strict';

  if (window.__raHoverOverlayActive) return;
  window.__raHoverOverlayActive = true;

  // ── CONSTANTS ──────────────────────────────────────────────────────────────

  const HOVER_MS      = 32;     // mousemove throttle ~30 fps
  const POLL_ACTIVE   = 300;    // playback poll while speaking
  // While nothing is playing this only has to notice that playback *started*, so
  // it doubles as the worst-case delay before the first highlight appears. Kept
  // at a second: long enough to cut most of the idle traffic, short enough that
  // pressing the toolbar button still feels immediate. Playback we start
  // ourselves does not wait for it — see seekTo.
  const POLL_IDLE     = 1000;
  const MIN_TEXT      = 12;     // min chars for a block to be readable
  const RESCAN_MS     = 500;    // debounce after DOM churn settles
  const FOLLOW_PAUSE  = 1200;   // ignore our own scrolling for this long

  // Highlight colours, chosen against the element's own text colour: light text
  // means a dark page, which needs a brighter and more opaque highlight to read.
  const HOVER_LIGHT = { fill: '#6c63ff', alpha: '0.18' };
  const HOVER_DARK  = { fill: '#8f88ff', alpha: '0.30' };
  const PLAY_LIGHT  = { fill: '#f5a623', alpha: '0.35' };
  const PLAY_DARK   = { fill: '#ffc65c', alpha: '0.42' };

  const INTERACTIVE = 'a,button,input,select,textarea,[contenteditable],[role="button"],[role="link"]';

  const BLOCK_TAGS = new Set([
    'p','li','blockquote','td','th','pre','figcaption',
    'h1','h2','h3','h4','h5','h6'
  ]);

  const IGNORE_SEL = (typeof readAloudDoc !== 'undefined' && readAloudDoc.ignoreTags)
    ? readAloudDoc.ignoreTags
    : 'select,textarea,button,label,audio,video,dialog,embed,nav,noframes,noscript,object,script,style,svg,aside,footer';

  // Rough count of readable content, used only to notice the page gaining or
  // losing a meaningful amount of text.
  const CANDIDATE_SEL = 'p,li,blockquote,td,th,pre,figcaption,h1,h2,h3,h4,h5,h6';

  // ── STATE ──────────────────────────────────────────────────────────────────

  let blocks   = [];
  let blockMap = new Map();     // el → index  (O(1) hit-test)

  // Per-element text and sentence splits.  Keyed by a generation counter rather
  // than validated per entry: any DOM edit could move text, and bumping one
  // integer is far cheaper than re-checking every element.
  let cache      = new WeakMap();
  let generation = 0;
  let lastCandidateCount = 0;

  // Hover layer (above the playback layer)
  let hovWrap = null, hovSvg = null, hovTimer = 0;
  let hovered = null;           // {el, sentence} currently previewed

  // Playback layer
  let actWrap = null, actSvg = null;
  let actRange = null;          // stored so scroll can repaint without a poll
  let actEl    = null;
  let pollTimer = null, pollRate = 0;
  let lastPlayKey = '';         // "index:text" — skip repaint when unchanged

  // Following the reading position
  let followSuspended = false;
  let selfScrollUntil = 0;

  // ── SENTENCES ──────────────────────────────────────────────────────────────
  //
  // The text a block contributes is not its textContent.  html-doc.js drops <sup>
  // and the ignore list before handing text to the engine, and the overlay has to
  // drop exactly the same things — sharing the splitter is not enough if the two
  // sides feed it different text.
  //
  // Wikipedia is where this shows: a citation marker sits between the full stop
  // and the space after it, so "…may lack clarity.[citation needed] For specific…"
  // has no whitespace behind the stop and the sentence boundary disappears. The
  // engine, reading "…may lack clarity. For specific…", splits it in two. The
  // overlay offered one hover target spanning both, so the second sentence could
  // not be picked and clicking it started reading from the first.

  const SKIP_IN_BLOCK = 'sup,' + IGNORE_SEL;

  function isSkipped(node, root) {
    for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
      try { if (el.matches(SKIP_IN_BLOCK)) return true; } catch (_) {}
    }
    return false;
  }

  // The text nodes that make up a block's readable text, in document order.
  // Cached with the text and the splits, because the offsets the splitter returns
  // only mean anything against this exact list — every offset→Range conversion has
  // to walk the same nodes that produced the text.
  function readableTextNodes(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n; (n = walker.nextNode());) if (!isSkipped(n, el)) nodes.push(n);
    return nodes;
  }

  function entry(el) {
    let e = cache.get(el);
    if (e && e.generation === generation) return e;
    const nodes = readableTextNodes(el);
    let text = '';
    for (let i = 0; i < nodes.length; i++) text += nodes[i].textContent;
    e = {
      generation,
      nodes,
      text,
      // getSentencesWithOffsets comes from js/punctuator.js, loaded ahead of this
      // file.  Guard anyway: a missing dependency should degrade to one sentence
      // per block, not throw on every mousemove.
      sentences: (typeof getSentencesWithOffsets === 'function')
        ? getSentencesWithOffsets(text, document.documentElement.lang)
        : [{ text: text.trim(), raw: text, start: 0, end: text.length }]
    };
    cache.set(el, e);
    return e;
  }

  function sentenceAt(sentences, offset) {
    for (const s of sentences) {
      if (offset >= s.start && offset <= s.end) return s;
    }
    return sentences[sentences.length - 1] || null;
  }

  // ── CURSOR → CHAR OFFSET ───────────────────────────────────────────────────

  function caretAt(x, y) {
    // Chrome shipped caretRangeFromPoint; Firefox implements the standard
    // caretPositionFromPoint.  Try both so neither is left without it.
    try {
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r) return { node: r.startContainer, offset: r.startOffset };
      }
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) return { node: p.offsetNode, offset: p.offset };
      }
    } catch (_) { /* detached node, cross-origin frame */ }
    return null;
  }

  function charOffsetInBlock(x, y, el) {
    const caret = caretAt(x, y);
    if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !el.contains(caret.node)) return 0;
    const nodes = entry(el).nodes;
    let off = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node === caret.node) return off + caret.offset;
      // The caret is in text we skipped — the cursor is over a citation marker.
      // Snap to the boundary in front of it rather than reporting 0, which would
      // name the first sentence of the block wherever the marker happened to be.
      if (node.compareDocumentPosition(caret.node) & Node.DOCUMENT_POSITION_PRECEDING) return off;
      off += node.textContent.length;
    }
    return off;
  }

  // ── CHAR POSITIONS → DOM RANGE ─────────────────────────────────────────────

  function createRangeForChars(el, startChar, endChar) {
    // The same node list the offsets were measured against — see entry().
    const nodes = entry(el).nodes;
    let offset = 0, sNode, sOff, eNode, eOff;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const len = node.textContent.length;
      if (!sNode && offset + len > startChar) {
        sNode = node;
        sOff  = startChar - offset;
      }
      if (sNode && offset + len >= endChar) {
        eNode = node;
        eOff  = endChar - offset;
        break;
      }
      offset += len;
    }
    if (!sNode) return null;
    try {
      const r = document.createRange();
      r.setStart(sNode, Math.min(sOff, sNode.textContent.length));
      r.setEnd(
        eNode || sNode,
        Math.min(eOff ?? sNode.textContent.length, (eNode || sNode).textContent.length)
      );
      return r;
    } catch (_) { return null; }
  }

  // ── BLOCK FROM CURSOR POINT ────────────────────────────────────────────────
  //
  // Two strategies, both O(depth).  The old third strategy measured every block
  // on the page with getBoundingClientRect to find the nearest — that ran on the
  // hover path and thrashed layout on long articles for an answer that was a
  // guess anyway.  If neither lookup finds a block, the cursor is not over one.

  function blockAt(node) {
    for (let el = (node && node.nodeType === Node.TEXT_NODE) ? node.parentElement : node;
         el && el !== document.body;
         el = el.parentElement) {
      const idx = blockMap.get(el);
      if (idx !== undefined) return idx;
    }
    return -1;
  }

  function blockFromPoint(x, y) {
    const caret = caretAt(x, y);
    if (caret) {
      const idx = blockAt(caret.node);
      if (idx >= 0) return idx;
    }
    // elementFromPoint still resolves when the point is in an element's padding
    // or over a float, where there is no caret to find.
    try {
      const idx = blockAt(document.elementFromPoint(x, y));
      if (idx >= 0) return idx;
    } catch (_) {}
    return -1;
  }

  // ── RECTS ──────────────────────────────────────────────────────────────────

  function getLineRects(range) {
    if (!range) return [];
    try {
      return [...range.getClientRects()].filter(r => r.width > 4 && r.height > 0);
    } catch (_) { return []; }
  }

  // caretRangeFromPoint snaps to the nearest character even when the cursor is in
  // empty margin beside a line, so reject hover unless the cursor really is over
  // the text — allowing a little horizontal fuzz and the leading gap between lines.
  function cursorNearRects(x, y, rects) {
    if (!rects.length) return false;
    const PAD_X = 4;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (x < r.left - PAD_X || x > r.right + PAD_X) continue;
      if (y >= r.top && y <= r.bottom) return true;
      if (i + 1 < rects.length && y > r.bottom && y < rects[i + 1].top) return true;
    }
    return false;
  }

  // ── COLOUR ─────────────────────────────────────────────────────────────────

  // ITU-R BT.601 luma of the element's *text* colour.  Text colour is always
  // resolvable; the effective background frequently is not (transparent stacks,
  // images, gradients), so this is the reliable signal for light-vs-dark.
  function isDarkPage(el) {
    try {
      const m = /^rgba?\(([^)]+)\)/i.exec(getComputedStyle(el).color);
      if (!m) return false;
      const p = m[1].split(/[,/\s]+/).filter(Boolean).map(parseFloat);
      if (p.length < 3) return false;
      return (299 * p[0] + 587 * p[1] + 114 * p[2]) / 1000 >= 160;
    } catch (_) { return false; }
  }

  // ── SVG HELPERS ────────────────────────────────────────────────────────────

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function makeSvgLayer(zIndex) {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-read-aloud-overlay', 'true');
    wrap.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:' + zIndex + ';overflow:hidden';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible';
    wrap.appendChild(svg);
    document.body.appendChild(wrap);
    return { wrap, svg };
  }

  // Update the rects already there rather than rebuilding them.  This runs on
  // every mousemove and on every scroll frame; discarding and recreating the
  // nodes each time is a style recalc and an allocation per line for nothing —
  // only the geometry actually changes between frames.
  function syncRects(svg, rects, colour) {
    if (!svg) return;
    const kids = svg.childNodes;
    let n = 0;
    for (const r of rects) {
      let el = kids[n];
      if (!el) {
        el = document.createElementNS(SVG_NS, 'rect');
        el.setAttribute('rx', '3');
        svg.appendChild(el);
      }
      el.setAttribute('x',      (r.left   - 1).toFixed(1));
      el.setAttribute('y',      (r.top    - 1).toFixed(1));
      el.setAttribute('width',  (r.width  + 2).toFixed(1));
      el.setAttribute('height', (r.height + 2).toFixed(1));
      if (el.__fill !== colour.fill) {
        el.setAttribute('fill', colour.fill);
        el.__fill = colour.fill;
      }
      if (el.__alpha !== colour.alpha) {
        el.setAttribute('fill-opacity', colour.alpha);
        el.__alpha = colour.alpha;
      }
      n++;
    }
    while (kids.length > n) svg.removeChild(svg.lastChild);
  }

  function clearSvg(svg) {
    if (svg) while (svg.firstChild) svg.removeChild(svg.firstChild);
  }

  // ── HOVER OVERLAY ──────────────────────────────────────────────────────────

  function ensureHovSvg() {
    if (hovWrap) return;
    const layer = makeSvgLayer(2147483646);
    hovWrap = layer.wrap; hovSvg = layer.svg;
  }

  function clearHover() {
    clearSvg(hovSvg);
    hovered = null;
  }

  function updateHover(x, y) {
    try {
      const idx = blockFromPoint(x, y);
      if (idx < 0) return clearHover();
      const el = blocks[idx];
      if (!el) return clearHover();              // stale index — rescan pending

      const e = entry(el);
      const sentence = sentenceAt(e.sentences, charOffsetInBlock(x, y, el));
      if (!sentence) return clearHover();

      const rects = getLineRects(createRangeForChars(el, sentence.start, sentence.end));
      if (!cursorNearRects(x, y, rects)) return clearHover();

      ensureHovSvg();
      syncRects(hovSvg, rects, isDarkPage(el) ? HOVER_DARK : HOVER_LIGHT);
      hovered = { el, sentence };
    } catch (_) { clearHover(); }
  }

  // ── PLAYBACK HIGHLIGHT ─────────────────────────────────────────────────────

  function ensureActSvg() {
    if (actWrap) return;
    const layer = makeSvgLayer(2147483644);
    actWrap = layer.wrap; actSvg = layer.svg;
  }

  function clearPlayback() {
    clearSvg(actSvg);
    actRange = null;
    actEl = null;
    lastPlayKey = '';
  }

  function repaintPlayback() {
    if (!actRange || !actSvg) return;
    syncRects(actSvg, getLineRects(actRange), isDarkPage(actEl || document.body) ? PLAY_DARK : PLAY_LIGHT);
  }

  function findTextInBlocks(needle) {
    if (!needle || !needle.trim()) return null;
    const prefix = needle.slice(0, 40);
    const lowerNeedle = needle.toLowerCase();
    const lowerPrefix = prefix.toLowerCase();
    for (const block of blocks) {
      // A block removed since the last scan still answers indexOf with the text it
      // used to hold, and the Range built from it has no client rects — so the
      // highlight would land nowhere and silently blank out.  Skipping it lets the
      // search fall through to a live block that has the same text.
      if (!block.isConnected) continue;
      const tc = entry(block).text;      // cached; textContent is not cheap
      let pos = tc.indexOf(needle);
      if (pos < 0) pos = tc.toLowerCase().indexOf(lowerNeedle);
      if (pos < 0) pos = tc.indexOf(prefix);
      if (pos < 0) pos = tc.toLowerCase().indexOf(lowerPrefix);
      if (pos < 0) continue;
      const end   = Math.min(tc.length, pos + needle.length);
      const range = createRangeForChars(block, pos, end);
      if (range) return { range, block };
    }
    return null;
  }

  function isRectOffscreen(rect) {
    return rect.bottom < 0 || rect.top > window.innerHeight;
  }

  // Follow the reading position, but never take the page away from someone who
  // scrolled somewhere themselves.  A timer cannot know whether they are still
  // reading that diagram three screens up, so following resumes on position
  // instead: once the highlight is back on screen by itself — because they
  // scrolled back, or because reading caught up — there is nothing to do anyway.
  function follow(rects, block) {
    if (!rects.length) return;
    const onScreen = !isRectOffscreen(rects[0]);
    if (followSuspended) {
      if (!onScreen) return;
      followSuspended = false;
      return;
    }
    if (onScreen) return;
    selfScrollUntil = Date.now() + FOLLOW_PAUSE;
    try {
      block.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) {
      block.scrollIntoView(true);
    }
  }

  function applyPlaybackHighlight(needle) {
    const found = findTextInBlocks(needle);
    if (!found) return clearPlayback();

    actRange = found.range;
    actEl = found.block;
    const rects = getLineRects(actRange);
    ensureActSvg();
    syncRects(actSvg, rects, isDarkPage(actEl) ? PLAY_DARK : PLAY_LIGHT);
    follow(rects, found.block);
  }

  // ── PLAYBACK POLLING ───────────────────────────────────────────────────────
  //
  // Poll rate follows the state: there is no reason to ask every 300 ms while
  // nothing is playing, and this runs for the whole life of every tab.

  function setPollRate(ms) {
    if (pollRate === ms) return;
    pollRate = ms;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollPlayback, ms);
  }

  async function pollPlayback() {
    let result;
    try {
      result = await safeSend({ dest: 'serviceWorker', method: 'getPlaybackState' });
    } catch (_) { return; }   // service worker asleep, or no player yet

    if (!result || result.state !== 'PLAYING') {
      setPollRate(POLL_IDLE);
      if (result && (result.state === 'PAUSED' || result.state === 'STOPPED')) {
        clearPlayback();
        followSuspended = false;
      }
      return;
    }
    setPollRate(POLL_ACTIVE);

    const info = result.speechInfo;
    if (!info || !info.texts || !info.texts.length) return;

    const idx  = (info.position && info.position.index != null) ? info.position.index : 0;
    const text = info.texts[idx];
    if (!text) return;

    const key = idx + ':' + text;
    if (key === lastPlayKey) return;   // no change — skip the DOM work
    lastPlayKey = key;

    applyPlaybackHighlight(text);
  }

  // ── SAFE MESSAGING ────────────────────────────────────────────────────────
  //
  // chrome.runtime.sendMessage() throws synchronously with "Extension context
  // invalidated" when the service worker has restarted (idle timeout, extension
  // reload) while this content script is still live.  That happens before a
  // Promise exists, so .catch() at the call site cannot catch it.

  function safeSend(msg) {
    try {
      const p = brapi.runtime.sendMessage(msg);
      return (p && typeof p.then === 'function') ? p : Promise.resolve(null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  // ── CLICK-TO-SEEK ──────────────────────────────────────────────────────────

  function seekTo(el, sentence) {
    // Signal html-doc.js's parse() to start from this sentence
    window.__raSeekTarget = {
      el: el,
      sentenceText: sentence.text.replace(/\s+/g, ' ').trim()
    };

    clearHover();
    clearPlayback();
    followSuspended = false;
    //We know playback is about to start, so do not make the highlight wait for
    //the idle poll to come round.
    setPollRate(POLL_ACTIVE);

    safeSend({ dest: 'serviceWorker', method: 'stop' })
      .catch(function () {})
      .then(function () {
        return safeSend({ dest: 'serviceWorker', method: 'playTab' });
      })
      .catch(function (err) { console.error('[RA hover] playTab failed:', err); });
  }

  function handlePointerUp(e) {
    try {
      if (e.button !== 0) return;
      if (window.getSelection().toString().length > 0) return;
      if (e.target.closest && e.target.closest(INTERACTIVE)) return;

      const idx = blockFromPoint(e.clientX, e.clientY);
      if (idx < 0) return;
      const el = blocks[idx];
      if (!el) return;                            // stale index — rescan pending
      const sentence = sentenceAt(entry(el).sentences, charOffsetInBlock(e.clientX, e.clientY, el));
      if (!sentence) return;

      seekTo(el, sentence);
    } catch (err) {
      console.error('[RA hover] click handler error:', err);
    }
  }

  // ── BLOCK SCANNING ─────────────────────────────────────────────────────────

  function isVisible(el) {
    if (!el.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function candidateCount() {
    try { return document.querySelectorAll(CANDIDATE_SEL).length; }
    catch (_) { return lastCandidateCount; }
  }

  function scanBlocks() {
    const candidates = [];
    function walk(el) {
      if (!el || el.nodeType !== 1) return;
      const tag = el.tagName.toLowerCase();
      if (BLOCK_TAGS.has(tag)) {
        if ((el.textContent || '').trim().length >= MIN_TEXT && isVisible(el))
          candidates.push(el);
        return;
      }
      try { if (el.matches(IGNORE_SEL)) return; } catch (_) {}
      for (let i = 0; i < el.children.length; i++) walk(el.children[i]);
    }
    walk(document.body);

    const set = new Set(candidates);
    blocks = candidates.filter(function (el) {
      let p = el.parentElement;
      while (p && p !== document.body) { if (set.has(p)) return false; p = p.parentElement; }
      return true;
    });
    blockMap = new Map(blocks.map(function (el, i) { return [el, i]; }));
    lastCandidateCount = candidateCount();
  }

  // ── EVENT WIRING ───────────────────────────────────────────────────────────

  document.addEventListener('mousemove', function (e) {
    if (hovTimer) return;
    hovTimer = setTimeout(function () { hovTimer = 0; }, HOVER_MS);
    if (e.target.closest && e.target.closest(INTERACTIVE)) { clearHover(); return; }
    updateHover(e.clientX, e.clientY);
  }, { capture: true, passive: true });

  document.addEventListener('mouseleave', clearHover, { capture: true });

  // Scroll: the hover preview is dropped (its coordinates are stale the moment
  // the page moves) and the playback highlight repositions from its stored Range.
  // Batched into a frame — scroll fires far more often than the screen updates.
  let scrollQueued = false;
  document.addEventListener('scroll', function () {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(function () {
      scrollQueued = false;
      clearHover();
      repaintPlayback();
    });
  }, { capture: true, passive: true });

  document.addEventListener('pointerup', handlePointerUp, { capture: true });

  // The user taking over.  Watching the input rather than the scroll event is
  // what makes this reliable: our own scrollIntoView produces scroll events too,
  // and telling them apart after the fact is guesswork.
  const SCROLL_KEYS = { ArrowUp:1, ArrowDown:1, PageUp:1, PageDown:1, Home:1, End:1, ' ':1, Spacebar:1 };

  function userTookOver() {
    if (Date.now() < selfScrollUntil) return;   // our own smooth scroll settling
    followSuspended = true;
  }

  window.addEventListener('wheel', userTookOver, { capture: true, passive: true });
  window.addEventListener('touchmove', userTookOver, { capture: true, passive: true });
  window.addEventListener('keydown', function (e) {
    if (!SCROLL_KEYS[e.key]) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    userTookOver();
  }, { capture: true });

  // ── SPA / DYNAMIC CONTENT RESCAN ──────────────────────────────────────────
  //
  // Apps rebuild the DOM without a navigation, which leaves blocks[] and blockMap
  // pointing at elements that are gone.  A MutationObserver notices, but it fires
  // constantly on any busy page, so the callback only arms a debounce and the
  // decision is made afterwards: rescan when the blocks have actually gone stale,
  // or when the amount of readable content has moved materially.  Mutations
  // inside our own overlays are ignored — otherwise drawing a highlight would
  // schedule a rescan of the page it is drawn on.

  let rescanTimer = null;

  // Sampled rather than exhaustive so this stays cheap on very long pages, but
  // sampled *across* the list: content is normally removed from one region, and a
  // prefix sample never sees a region that is not at the front.  Measured on the
  // Wikipedia "Speech synthesis" article, 151 of 503 indexed blocks were detached
  // and every one of them sat past position 345, so a first-12 sample reported the
  // index as healthy and it never self-corrected.
  //
  // The trigger is the same 15% materiality used for the candidate delta below.
  // A detached block is always wrong, but one stray removal is not worth a full
  // walk of the document — that is the whole point of the gate.
  const STALE_SAMPLE = 32;

  function blocksAreStale() {
    if (!blocks.length) return false;
    const stride = Math.max(1, Math.floor(blocks.length / STALE_SAMPLE));
    let checked = 0, detached = 0;
    for (let i = 0; i < blocks.length && checked < STALE_SAMPLE; i += stride) {
      const el = blocks[i];
      if (!el) continue;
      checked++;
      if (!el.isConnected) detached++;
    }
    return checked > 0 && detached / checked > 0.15;
  }

  function contentChangedMaterially() {
    if (!blocks.length) return true;
    if (blocksAreStale()) return true;
    const delta = Math.abs(candidateCount() - lastCandidateCount);
    return delta >= Math.max(4, lastCandidateCount * 0.15);
  }

  function scheduleRescan() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(function () {
      rescanTimer = null;
      if (!contentChangedMaterially()) return;
      clearHover();
      clearPlayback();
      generation++;              // every cached text and split now describes the old DOM
      scanBlocks();
    }, RESCAN_MS);
  }

  function isOurNode(node) {
    return !!(node && node.nodeType === 1 && node.closest &&
              node.closest('[data-read-aloud-overlay]'));
  }

  function isOurMutation(m) {
    if (isOurNode(m.target)) return true;
    const touched = [];
    for (let i = 0; i < m.addedNodes.length; i++) touched.push(m.addedNodes[i]);
    for (let j = 0; j < m.removedNodes.length; j++) touched.push(m.removedNodes[j]);
    if (!touched.length) return true;
    for (let k = 0; k < touched.length; k++) if (!isOurNode(touched[k])) return false;
    return true;
  }

  const domObserver = new MutationObserver(function (mutations) {
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (m.type !== 'childList') continue;
      if (!m.addedNodes.length && !m.removedNodes.length) continue;
      if (isOurMutation(m)) continue;
      scheduleRescan();
      return;                    // one rescan is enough — the debounce handles the rest
    }
  });

  domObserver.observe(document.body, { childList: true, subtree: true });

  // ── INIT ───────────────────────────────────────────────────────────────────

  scanBlocks();

  // Start polling straight away: Read Aloud may already be speaking (the user
  // could have pressed the toolbar button before this script was injected).
  setPollRate(POLL_ACTIVE);

})();
