// Read Aloud — Speechify-style hover + click overlay + playback highlight
//
// Three layers:
//
//   1. HOVER PREVIEW (purple, z:2147483646)
//      mousemove (32 ms throttle) → blockFromPoint → charOffsetInBlock →
//      sentenceAtOffset → createRangeForChars → getClientRects →
//      per-line SVG <rect rx=3>
//
//   2. CLICK-TO-SEEK
//      pointerup → same pipeline → window.__raSeekTarget = {el, sentenceText}
//      → brapi stop → brapi playTab   (html-doc.js consumes __raSeekTarget)
//
//   3. PLAYBACK HIGHLIGHT (amber, z:2147483644)
//      setInterval 300 ms → getPlaybackState → texts[position.index] →
//      findTextInBlocks (textContent indexOf) → createRangeForChars →
//      per-line SVG <rect rx=3>   Stored Range repositions on scroll.
//      Auto-scrolls block into view when it leaves the viewport.

(function () {
  'use strict';

  if (window.__raHoverOverlayActive) return;
  window.__raHoverOverlayActive = true;

  // ── CONSTANTS ──────────────────────────────────────────────────────────────

  const HOVER_MS     = 32;          // mousemove throttle ~30 fps
  const POLL_MS      = 300;         // playback state poll interval
  const MIN_TEXT     = 12;          // min chars for a block to be readable
  const HOVER_COLOR  = '#6c63ff';   // purple  — hover preview
  const HOVER_ALPHA  = '0.18';
  const PLAY_COLOR   = '#f5a623';   // amber   — active playback sentence
  const PLAY_ALPHA   = '0.35';

  const INTERACTIVE  = 'a,button,input,select,textarea,[contenteditable],[role="button"],[role="link"]';

  // Abbreviations whose period must NOT end a sentence
  const ABBREVS = new Set([
    'mr','mrs','ms','dr','prof','sr','jr','vs','etc',
    'e.g','i.e','fig','no','vol','dept','approx','est',
    'govt','inc','ltd','corp','co','st','ave','blvd',
    'jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec',
    'u.s','u.k','u.n','p.m','a.m',
  ]);

  // ── STATE ──────────────────────────────────────────────────────────────────

  let blocks    = [];
  let blockMap  = new Map();      // el → index  (O(1) hit-test)
  let sentCache = new WeakMap();  // el → [{text, start, end}]

  // Hover SVG (purple, above playback layer)
  let hovWrap = null, hovSvg = null, hovTimer = 0;

  // Playback SVG (amber, below hover layer)
  let actWrap = null, actSvg = null;
  let actRange  = null;   // stored so scroll can repaint without waiting for poll
  let pollTimer = null;
  let lastPlayKey = '';   // "index:text" — skip repaint when unchanged

  // ── SENTENCE SPLITTING ─────────────────────────────────────────────────────

  function splitSentences(text) {
    if (!text) return [];
    const results = [];
    const re = /([.!?]['"»)\]]*)\s+(?=[A-Z"'«(\[])/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      const prefix = text.slice(0, m.index + 1);
      const abbr   = prefix.match(/\b([A-Za-z][a-z]*)\.$/);
      if (abbr && ABBREVS.has(abbr[1].toLowerCase())) continue;
      const end   = m.index + m[1].length;
      const chunk = text.slice(last, end).trim();
      if (chunk.length > 1) results.push({ text: chunk, start: last, end });
      last = m.index + m[0].length;
    }
    const tail = text.slice(last).trim();
    if (tail.length > 1) results.push({ text: tail, start: last, end: text.length });
    return results.length ? results : [{ text: text.trim(), start: 0, end: text.length }];
  }

  function getSentences(el) {
    if (sentCache.has(el)) return sentCache.get(el);
    const s = splitSentences(el.textContent);
    sentCache.set(el, s);
    return s;
  }

  function sentenceAt(sents, offset) {
    for (const s of sents) {
      if (offset >= s.start && offset <= s.end) return s;
    }
    return sents[sents.length - 1] || null;
  }

  // ── CURSOR → CHAR OFFSET  (Speechify Xe() technique) ──────────────────────

  function charOffsetInBlock(x, y, el) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
    }
    if (!range) return 0;
    const tn = range.startContainer;
    if (tn.nodeType !== Node.TEXT_NODE || !el.contains(tn)) return 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let off = 0;
    for (let node; (node = walker.nextNode());) {
      if (node === tn) return off + range.startOffset;
      off += node.textContent.length;
    }
    return 0;
  }

  // ── CHAR POSITIONS → DOM RANGE ─────────────────────────────────────────────

  function createRangeForChars(el, startChar, endChar) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let offset = 0, sNode, sOff, eNode, eOff;
    for (let node; (node = walker.nextNode());) {
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

  function blockFromPoint(x, y) {
    try {
      if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        if (range) {
          let node = range.startContainer;
          if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
          while (node && node !== document.body) {
            const idx = blockMap.get(node);
            if (idx !== undefined) return idx;
            node = node.parentElement;
          }
        }
      }
    } catch (_) { /* cross-origin frame, ShadowRoot, or detached node */ }
    let best = -1, bestD = Infinity;
    blocks.forEach((el, i) => {
      try {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const d = Math.abs((r.top + r.bottom) / 2 - y);
        if (d < bestD) { bestD = d; best = i; }
      } catch (_) {}
    });
    return best;
  }

  // ── LINE RECTS FROM RANGE ──────────────────────────────────────────────────

  function getLineRects(range) {
    if (!range) return [];
    try {
      return [...range.getClientRects()].filter(r => r.width > 4 && r.height > 0);
    } catch (_) { return []; }
  }

  // ── CURSOR HIT-TEST ────────────────────────────────────────────────────────
  //
  // caretRangeFromPoint() snaps to the nearest character even when the cursor
  // is in empty margin space beside a line.  We reject hover unless the cursor
  // is physically over (or between adjacent lines of) the sentence's text rects.
  //
  //   PAD_X — small horizontal fuzz so the very edge of a glyph still triggers
  //   inter-line gap — if cursor Y is between rect[i].bottom and rect[i+1].top
  //     (the typographic leading gap) we still consider it "over" the sentence

  function cursorNearRects(x, y, rects) {
    if (!rects.length) return false;
    const PAD_X = 4;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      // Cursor must be horizontally inside the text run (± PAD_X)
      if (x < r.left - PAD_X || x > r.right + PAD_X) continue;
      // Vertically inside this line rect
      if (y >= r.top && y <= r.bottom) return true;
      // Vertically in the leading gap between this line and the next
      if (i + 1 < rects.length && y > r.bottom && y < rects[i + 1].top) return true;
    }
    return false;
  }

  // ── SVG HELPERS ────────────────────────────────────────────────────────────

  function makeSvgLayer(zIndex) {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:' + zIndex + ';overflow:hidden';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible';
    wrap.appendChild(svg);
    document.body.appendChild(wrap);
    return { wrap, svg };
  }

  function fillSvg(svg, rects, color, alpha) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    for (const r of rects) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      el.setAttribute('x',            (r.left   - 1).toFixed(1));
      el.setAttribute('y',            (r.top    - 1).toFixed(1));
      el.setAttribute('width',        (r.width  + 2).toFixed(1));
      el.setAttribute('height',       (r.height + 2).toFixed(1));
      el.setAttribute('rx',           '3');
      el.setAttribute('fill',         color);
      el.setAttribute('fill-opacity', alpha);
      svg.appendChild(el);
    }
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

  function clearHover() { clearSvg(hovSvg); }

  function updateHover(x, y) {
    try {
      const idx = blockFromPoint(x, y);
      if (idx < 0) { clearHover(); return; }
      const el = blocks[idx];
      if (!el) { clearHover(); return; }   // stale index — rescan pending
      const sents = getSentences(el);
      const off   = charOffsetInBlock(x, y, el);
      const sent  = sentenceAt(sents, off);
      if (!sent) { clearHover(); return; }
      const range = createRangeForChars(el, sent.start, sent.end);
      const rects = getLineRects(range);
      // Reject if cursor is in the empty margin beside the text line
      if (!cursorNearRects(x, y, rects)) { clearHover(); return; }
      ensureHovSvg();
      fillSvg(hovSvg, rects, HOVER_COLOR, HOVER_ALPHA);
    } catch (_) { clearHover(); }
  }

  // ── PLAYBACK HIGHLIGHT ─────────────────────────────────────────────────────
  //
  // Poll getPlaybackState every POLL_MS.
  // texts[position.index] = currently spoken sentence (Supertonic/Piper) or
  //   750-char chunk (Chrome TTS).
  // Search block.textContent with a 4-tier fallback:
  //   exact → case-insensitive → 40-char prefix exact → 40-char prefix CI
  // Store the Range so scroll can repaint instantly without waiting for a poll.

  function ensureActSvg() {
    if (actWrap) return;
    const layer = makeSvgLayer(2147483644);
    actWrap = layer.wrap; actSvg = layer.svg;
  }

  function clearPlayback() {
    clearSvg(actSvg);
    actRange   = null;
    lastPlayKey = '';
  }

  function repaintPlayback() {
    if (!actRange || !actSvg) return;
    fillSvg(actSvg, getLineRects(actRange), PLAY_COLOR, PLAY_ALPHA);
  }

  function findTextInBlocks(needle) {
    if (!needle || !needle.trim()) return null;
    const prefix = needle.slice(0, 40);
    for (const block of blocks) {
      const tc = block.textContent;
      let pos = tc.indexOf(needle);
      if (pos < 0) pos = tc.toLowerCase().indexOf(needle.toLowerCase());
      if (pos < 0) pos = tc.indexOf(prefix);
      if (pos < 0) pos = tc.toLowerCase().indexOf(prefix.toLowerCase());
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

  function applyPlaybackHighlight(needle) {
    const found = findTextInBlocks(needle);
    if (!found) { clearPlayback(); return; }

    actRange = found.range;
    const rects = getLineRects(actRange);
    ensureActSvg();
    fillSvg(actSvg, rects, PLAY_COLOR, PLAY_ALPHA);

    // Auto-scroll: bring the highlighted sentence into view if it left viewport
    if (rects.length > 0 && isRectOffscreen(rects[0])) {
      found.block.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  async function pollPlayback() {
    let result;
    try {
      result = await safeSend({ dest: 'serviceWorker', method: 'getPlaybackState' });
    } catch (_) { return; }  // service worker sleeping or no player yet

    if (!result || result.state !== 'PLAYING') {
      // Clear the highlight when paused/stopped, but don't stop polling —
      // the user may press play again at any time.
      if (result && (result.state === 'PAUSED' || result.state === 'STOPPED')) {
        clearPlayback();
      }
      return;
    }

    const info = result.speechInfo;
    if (!info || !info.texts || !info.texts.length) return;

    const idx  = (info.position && info.position.index != null) ? info.position.index : 0;
    const text = info.texts[idx];
    if (!text) return;

    const key = idx + ':' + text;
    if (key === lastPlayKey) return;   // no change — skip DOM work
    lastPlayKey = key;

    applyPlaybackHighlight(text);
  }

  // ── SAFE MESSAGING ────────────────────────────────────────────────────────
  //
  // chrome.runtime.sendMessage() throws synchronously with
  // "Extension context invalidated" when the service worker has restarted
  // (idle timeout, extension reload) while this content script is still live.
  // That happens before a Promise is returned, so .catch() on the call-site
  // can't catch it.  Wrap every outgoing message here instead.

  function safeSend(msg) {
    try {
      const p = brapi.runtime.sendMessage(msg);
      // brapi may return undefined for one-way messages
      return (p && typeof p.then === 'function') ? p : Promise.resolve(null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  // ── CLICK-TO-SEEK ──────────────────────────────────────────────────────────

  function handlePointerUp(e) {
    try {
      if (e.button !== 0) return;
      if (window.getSelection().toString().length > 0) return;
      if (e.target.closest && e.target.closest(INTERACTIVE)) return;

      const idx = blockFromPoint(e.clientX, e.clientY);
      if (idx < 0) return;
      const el = blocks[idx];
      if (!el) return;   // stale index — rescan pending
      const sents = getSentences(el);
      const off   = charOffsetInBlock(e.clientX, e.clientY, el);
      const sent  = sentenceAt(sents, off);
      if (!sent) return;

      // Signal html-doc.js's parse() to start from this sentence
      window.__raSeekTarget = {
        el:           el,
        sentenceText: sent.text.replace(/\s+/g, ' ').trim()
      };

      // Clear both overlays — they will repopulate once new playback starts
      clearHover();
      clearPlayback();

      safeSend({ dest: 'serviceWorker', method: 'stop' })
        .catch(function () {})
        .then(function () {
          return safeSend({ dest: 'serviceWorker', method: 'playTab' });
        })
        .catch(function (err) { console.error('[RA hover] playTab failed:', err); });
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

  const BLOCK_TAGS = new Set([
    'p','li','blockquote','td','th','pre','figcaption',
    'h1','h2','h3','h4','h5','h6'
  ]);

  const IGNORE_SEL = (typeof readAloudDoc !== 'undefined' && readAloudDoc.ignoreTags)
    ? readAloudDoc.ignoreTags
    : 'select,textarea,button,label,audio,video,dialog,embed,nav,noframes,noscript,object,script,style,svg,aside,footer';

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
  }

  // ── EVENT WIRING ───────────────────────────────────────────────────────────

  // Hover preview
  document.addEventListener('mousemove', function (e) {
    if (hovTimer) return;
    hovTimer = setTimeout(function () { hovTimer = 0; }, HOVER_MS);
    if (e.target.closest && e.target.closest(INTERACTIVE)) { clearHover(); return; }
    ensureHovSvg();
    updateHover(e.clientX, e.clientY);
  }, { capture: true, passive: true });

  document.addEventListener('mouseleave', clearHover, { capture: true });

  // Scroll: hover clears (stale viewport coords), playback repositions from stored Range
  document.addEventListener('scroll', function () {
    clearHover();
    repaintPlayback();
  }, { capture: true, passive: true });

  // Click to seek
  document.addEventListener('pointerup', handlePointerUp, { capture: true });

  // ── SPA / DYNAMIC CONTENT RESCAN ──────────────────────────────────────────
  //
  // React/Vue SPAs tear down and rebuild DOM on navigation.  When that happens
  // blocks[] and blockMap become stale — old indices no longer map to live
  // elements.  Watch for structural DOM mutations and re-scan after a short
  // debounce (500 ms) so the new content is fully rendered first.
  // Changes inside our own SVG overlay divs are deliberately ignored.

  let rescanTimer = null;

  function scheduleRescan() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(function () {
      rescanTimer = null;
      clearHover();
      clearPlayback();
      sentCache = new WeakMap();   // sentence splits for old elements are stale
      scanBlocks();
    }, 500);
  }

  const domObserver = new MutationObserver(function (mutations) {
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (m.type !== 'childList') continue;
      if (m.addedNodes.length === 0 && m.removedNodes.length === 0) continue;
      // Skip mutations inside our own overlay wrappers
      if (hovWrap && hovWrap.contains(m.target)) continue;
      if (actWrap && actWrap.contains(m.target)) continue;
      scheduleRescan();
      return;   // one rescan is enough — debounce handles the rest
    }
  });

  domObserver.observe(document.body, { childList: true, subtree: true });

  // ── INIT ───────────────────────────────────────────────────────────────────

  scanBlocks();

  // Start polling immediately — Read Aloud may already be playing (e.g. user
  // clicked the toolbar button, then scrolled down).  300 ms is cheap enough
  // to run continuously while the tab is open.
  pollTimer = setInterval(pollPlayback, POLL_MS);

})();
