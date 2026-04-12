// Read Aloud — Speechify-style hover + click overlay
//
// Pipeline (mirrors Speechify's init-RF5QMWXQ.js):
//   mousemove (32 ms throttle)
//     → blockFromPoint      caretRangeFromPoint + parent-walk → block index
//     → charOffsetInBlock   TreeWalker accumulation → char offset into textContent
//     → sentenceAtOffset    binary scan of splitSentences() result
//     → createRangeForChars TreeWalker → DOM Range from [start, end] offsets
//     → getRects            Range.getClientRects() → one DOMRect per visual line
//     → paintRects          one SVG <rect rx=3> per line → clean rounded highlight
//
//   pointerup
//     → same pipeline to find sentence
//     → window.__raSeekTarget = { el, sentenceText }
//     → brapi stop → brapi playTab   (html-doc.js consumes __raSeekTarget)

(function () {
  'use strict';

  if (window.__raHoverOverlayActive) return;
  window.__raHoverOverlayActive = true;

  // ── CONSTANTS ──────────────────────────────────────────────────────────────

  const HOVER_MS    = 32;    // mousemove throttle
  const MIN_TEXT    = 12;    // minimum chars for a block to be hoverable
  const FILL_COLOR  = '#6c63ff';
  const HOVER_ALPHA = '0.18';

  const INTERACTIVE = 'a,button,input,select,textarea,[contenteditable],[role="button"],[role="link"]';

  // Abbreviations that must NOT end a sentence (Speechify technique)
  const ABBREVS = new Set([
    'mr','mrs','ms','dr','prof','sr','jr','vs','etc',
    'e.g','i.e','fig','no','vol','dept','approx','est',
    'govt','inc','ltd','corp','co','st','ave','blvd',
    'jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec',
    'u.s','u.k','u.n','p.m','a.m',
  ]);

  // ── STATE ──────────────────────────────────────────────────────────────────

  let blocks    = [];           // readable DOM elements
  let blockMap  = new Map();    // el → index (O(1) lookup)
  let sentCache = new WeakMap();// el → [{text,start,end}]
  let svgWrap   = null;
  let svgEl     = null;
  let hovTimer  = 0;

  // ── SENTENCE SPLITTING ─────────────────────────────────────────────────────
  // Returns [{text, start, end}] where start/end are offsets into the raw text.
  // Skips abbreviation-period boundaries (Dr., U.S., etc.) — the main quality
  // improvement over a naive .!? regex.

  function splitSentences(text) {
    if (!text) return [];
    const results = [];
    // Boundary: .!? + optional closing punctuation, whitespace, then uppercase / opening quote
    const re = /([.!?]['"»)\]]*)\s+(?=[A-Z"'«(\[])/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      // Check if the token before the period is an abbreviation
      const prefix = text.slice(0, m.index + 1);
      const abbr   = prefix.match(/\b([A-Za-z][a-z]*)\.$/);
      if (abbr && ABBREVS.has(abbr[1].toLowerCase())) continue;
      const end   = m.index + m[1].length;
      const chunk = text.slice(last, end).trim();
      if (chunk.length > 1) results.push({ text: chunk, start: last, end });
      last = m.index + m[0].length;   // skip punctuation + whitespace
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

  // ── CURSOR → CHAR OFFSET (Speechify's Xe() technique) ─────────────────────
  // caretRangeFromPoint gives (textNode, offsetWithinNode).
  // TreeWalker accumulates preceding text-node lengths → absolute offset.

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
    // Primary: walk up from caretRangeFromPoint's text node
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
    // Fallback: nearest block by vertical centre distance
    let best = -1, bestD = Infinity;
    blocks.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const d = Math.abs((r.top + r.bottom) / 2 - y);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  // ── SVG OVERLAY ────────────────────────────────────────────────────────────
  // One <rect rx="3"> per visual line from Range.getClientRects().
  // SVG is position:fixed so it tracks the viewport; on scroll we clear it
  // (mousemove will repaint on the next event).

  function ensureSvg() {
    if (svgWrap) return;
    svgWrap = document.createElement('div');
    svgWrap.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:2147483646;overflow:hidden';
    svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible';
    svgWrap.appendChild(svgEl);
    document.body.appendChild(svgWrap);
  }

  function paintRects(rects) {
    if (!svgEl) return;
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    for (const r of rects) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x',            (r.left   - 1).toFixed(1));
      rect.setAttribute('y',            (r.top    - 1).toFixed(1));
      rect.setAttribute('width',        (r.width  + 2).toFixed(1));
      rect.setAttribute('height',       (r.height + 2).toFixed(1));
      rect.setAttribute('rx',           '3');
      rect.setAttribute('fill',         FILL_COLOR);
      rect.setAttribute('fill-opacity', HOVER_ALPHA);
      svgEl.appendChild(rect);
    }
  }

  function clearOverlay() {
    if (svgEl) while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  }

  function getLineRects(range) {
    if (!range) return [];
    try {
      return [...range.getClientRects()].filter(r => r.width > 4 && r.height > 0);
    } catch (_) { return []; }
  }

  // ── HOVER PIPELINE ─────────────────────────────────────────────────────────

  function updateHover(x, y) {
    const idx = blockFromPoint(x, y);
    if (idx < 0) { clearOverlay(); return; }

    const el    = blocks[idx];
    const sents = getSentences(el);
    const off   = charOffsetInBlock(x, y, el);
    const sent  = sentenceAt(sents, off);
    if (!sent) { clearOverlay(); return; }

    const range = createRangeForChars(el, sent.start, sent.end);
    const rects = getLineRects(range);
    paintRects(rects);
  }

  // ── CLICK-TO-SEEK ──────────────────────────────────────────────────────────

  function handlePointerUp(e) {
    if (e.button !== 0) return;
    if (window.getSelection().toString().length > 0) return;
    if (e.target.closest && e.target.closest(INTERACTIVE)) return;

    const idx = blockFromPoint(e.clientX, e.clientY);
    if (idx < 0) return;
    const el    = blocks[idx];
    const sents = getSentences(el);
    const off   = charOffsetInBlock(e.clientX, e.clientY, el);
    const sent  = sentenceAt(sents, off);
    if (!sent) return;

    // Store seek target — html-doc.js reads this on the very next getTexts() call.
    // sentenceText is normalised (collapsed whitespace) so html-doc's indexOf
    // matches even when innerText/textContent differ slightly.
    window.__raSeekTarget = {
      el:           el,
      sentenceText: sent.text.replace(/\s+/g, ' ').trim()
    };

    // Clear the hover overlay immediately so it doesn't linger during loading
    clearOverlay();

    // Stop → playTab.  We use .then() instead of .finally() for broader compat.
    // The seek target sits safely on window until html-doc's getTexts() consumes it.
    brapi.runtime.sendMessage({ dest: 'serviceWorker', method: 'stop' })
      .catch(function () {})
      .then(function () {
        return brapi.runtime.sendMessage({ dest: 'serviceWorker', method: 'playTab' });
      })
      .catch(function (err) { console.error('[RA hover] playTab failed:', err); });
  }

  // ── BLOCK SCANNING ─────────────────────────────────────────────────────────
  // Mirrors the logic in html-doc.js's findTextBlocks but focused on the tags
  // that reliably contain sentence-level prose.

  function isVisible(el) {
    if (!el.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  var BLOCK_TAGS = new Set(['p','li','blockquote','td','th','pre','figcaption',
                             'h1','h2','h3','h4','h5','h6']);

  // ignoreTags from html-doc.js's readAloudDoc (available in same scope after injection)
  var IGNORE_SEL = (typeof readAloudDoc !== 'undefined' && readAloudDoc.ignoreTags)
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
        return;   // don't recurse into block elements
      }
      // Skip ignored tags
      try { if (el.matches(IGNORE_SEL)) return; } catch (_) {}
      for (let i = 0; i < el.children.length; i++) walk(el.children[i]);
    }
    walk(document.body);

    // Keep only outermost elements (drop descendants of already-included elements)
    const set = new Set(candidates);
    blocks = candidates.filter(function (el) {
      var p = el.parentElement;
      while (p && p !== document.body) { if (set.has(p)) return false; p = p.parentElement; }
      return true;
    });

    blockMap = new Map(blocks.map(function (el, i) { return [el, i]; }));
  }

  // ── EVENT WIRING ───────────────────────────────────────────────────────────

  document.addEventListener('mousemove', function (e) {
    if (hovTimer) return;
    hovTimer = setTimeout(function () { hovTimer = 0; }, HOVER_MS);
    if (e.target.closest && e.target.closest(INTERACTIVE)) { clearOverlay(); return; }
    ensureSvg();
    updateHover(e.clientX, e.clientY);
  }, { capture: true, passive: true });

  document.addEventListener('mouseleave',  clearOverlay,              { capture: true });
  document.addEventListener('scroll',      clearOverlay,              { capture: true, passive: true });
  document.addEventListener('pointerup',   handlePointerUp,           { capture: true });

  // ── INIT ───────────────────────────────────────────────────────────────────
  scanBlocks();

})();
