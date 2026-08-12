/**
 * Cross-browser regression baseline for js/content/hover-overlay.js.
 *
 * hover-overlay.js is a self-executing content script with no exports: blocks[],
 * blockMap and the SVG layers are all closed over. Everything here is therefore
 * observed from the outside -- the SVG rects it draws, the messages it sends
 * through the brapi stub, and window.__raSeekTarget -- which is also the only
 * honest way to pin behaviour, since none of it is reachable by unit test.
 *
 * Two phases:
 *   1. harness.html runs the assertions that need no pointer (playback highlight,
 *      block scanning probed through findTextInBlocks) and sets window.__done.
 *   2. this runner drives a real mouse for hover, click-to-seek and rescan.
 *
 * Chromium and Firefox disagree about the caret API -- Chromium has
 * document.caretRangeFromPoint, Firefox only has caretPositionFromPoint -- and
 * blockFromPoint() only calls the former, so the two engines take entirely
 * different paths to "which block is under the cursor". Running both is the only
 * way to see that.
 *
 *   npm run test:browser
 *   (requires: npm i -D playwright && npx playwright install chromium firefox)
 */
import { chromium, firefox } from 'playwright'
import { createServer } from 'http'
import { readFile } from 'fs/promises'
import { extname, normalize, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }
const PORT = 8733

const server = createServer(async (req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0])
  if (url === '/') url = '/harness.html'
  const base = url.startsWith('/js/') ? REPO : HERE
  try {
    const body = await readFile(normalize(base + url))
    res.writeHead(200, { 'Content-Type': TYPES[extname(url)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('not found')
  }
})
await new Promise(f => server.listen(PORT, f))

const ONLY = process.argv[2]
const ENGINES = [['chromium', chromium], ['firefox', firefox]]
  .filter(([name]) => !ONLY || ONLY === name)

let totalFail = 0
const summary = []

for (const [name, engine] of ENGINES) {
  console.log('\n' + '='.repeat(64) + '\n' + name.toUpperCase() + '\n' + '='.repeat(64))
  const browser = await engine.launch()
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push('pageerror: ' + String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

  await page.goto(`http://localhost:${PORT}/`)
  await page.waitForFunction(() => window.__done, null, { timeout: 60000 })

  console.log(await page.evaluate(() => document.getElementById('results').textContent))
  const done = await page.evaluate(() => window.__done)

  // The final render() wrote to #results, which is a childList mutation and so
  // schedules the 500 ms rescan. Wait it out before touching anything.
  await page.waitForTimeout(900)

  console.log('\nlive pointer interaction:')
  let livePass = 0, liveFail = 0
  const live = (desc, cond, extra) => {
    if (cond) { livePass++; console.log('  ok   ' + desc) }
    else { liveFail++; console.log('  FAIL ' + desc + (extra ? '\n         ' + extra : '')) }
  }

  // Coordinates are always recomputed immediately before use: the page scrolls
  // (scrollIntoView here, auto-scroll inside the overlay) and the results panel
  // changed height, so anything captured earlier points at the wrong text.
  const pointAt = (id, needle) => page.evaluate(
    ([id, needle]) => window.__pointAtText(id, needle), [id, needle])
  const hoverRects = () => page.evaluate(() => window.__hoverRects())
  const playRects = () => page.evaluate(() => window.__playRects())
  const seek = () => page.evaluate(() => window.__seek())
  const calls = () => page.evaluate(() => window.__calls().map(m => m.method))
  const reset = () => page.evaluate(() => window.__resetSeek())

  const hoverAt = async (id, needle) => {
    const p = await pointAt(id, needle)
    if (!p) return { point: null, rects: [] }
    await page.mouse.move(p.x, p.y)
    await page.waitForTimeout(160)
    return { point: p, rects: await hoverRects() }
  }
  const moveOff = async () => { await page.mouse.move(2, 2); await page.waitForTimeout(160) }

  // ── hover preview ─────────────────────────────────────────────────────────
  let h = await hoverAt('p1', 'Ambient computing did not arrive')
  live('target text is on screen', h.point && h.point.onScreen, JSON.stringify(h.point))
  live('hovering a sentence draws rects', h.rects.length > 0, 'rects=' + h.rects.length)
  live('hover rects are purple at 0.18 opacity with rx 3',
    h.rects.length > 0 && h.rects.every(r =>
      r.fill === '#6c63ff' && r.alpha === '0.18' && r.rx === '3'),
    JSON.stringify(h.rects[0]))
  live('hover rects sit over the hovered paragraph',
    await page.evaluate(rs => window.__rectsOver(rs, 'p1'), h.rects),
    JSON.stringify(h.rects[0]))

  // Only the hovered sentence, not the whole paragraph: p1 has two sentences on
  // (typically) two lines, so a sentence highlight must not cover both.
  const p1Lines = await page.evaluate(() => window.__lineCount('p1'))
  live('hover covers one sentence, not the whole block',
    h.rects.length < p1Lines || p1Lines === 1,
    'sentence rects=' + h.rects.length + ' paragraph lines=' + p1Lines)

  // empty margin beside the text: caretRangeFromPoint snaps to the nearest
  // character, so only cursorNearRects() stops a phantom highlight here
  const margin = await page.evaluate(() => {
    const b = document.getElementById('p1').getBoundingClientRect()
    return { x: 20, y: Math.round(b.top + b.height / 2) }
  })
  await page.mouse.move(margin.x, margin.y)
  await page.waitForTimeout(160)
  live('hovering the empty margin beside a line draws nothing',
    (await hoverRects()).length === 0, JSON.stringify(await hoverRects()))

  // empty space far below the article
  const tail = await page.evaluate(() => {
    const el = document.getElementById('tail')
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    const b = el.getBoundingClientRect()
    return { x: 400, y: Math.round(b.top + b.height / 2) }
  })
  await page.mouse.move(tail.x, tail.y)
  await page.waitForTimeout(160)
  live('hovering empty space below the article draws nothing',
    (await hoverRects()).length === 0, JSON.stringify(await hoverRects()))

  // an inline link is interactive: no preview, because clicking it must follow
  // the link rather than start reading
  const linkPoint = await page.evaluate(() => {
    const el = document.getElementById('thelink')
    const p = el.getBoundingClientRect()
    if (p.top < 70 || p.bottom > window.innerHeight - 40) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
    }
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  })
  await page.mouse.move(linkPoint.x, linkPoint.y)
  await page.waitForTimeout(160)
  live('hovering an inline link draws nothing',
    (await hoverRects()).length === 0, JSON.stringify(await hoverRects()))

  await moveOff()
  live('moving away clears the preview', (await hoverRects()).length === 0)

  // ── the preview follows the sentence, not the block ───────────────────────
  const s1 = await hoverAt('plong', 'The first sentence sets up')
  const g1 = s1.rects.map(r => ({ x: r.x, y: r.y, w: r.w }))
  await moveOff()
  const s2 = await hoverAt('plong', 'The second sentence develops')
  const g2 = s2.rects.map(r => ({ x: r.x, y: r.y, w: r.w }))

  live('hovering sentence 1 of a long paragraph draws rects', g1.length > 0,
    JSON.stringify(s1.point))
  live('hovering sentence 2 of the same paragraph draws rects', g2.length > 0,
    JSON.stringify(s2.point))
  live('the two sentences produce different geometry',
    g1.length > 0 && g2.length > 0 && JSON.stringify(g1) !== JSON.stringify(g2),
    's1=' + JSON.stringify(g1) + '\n         s2=' + JSON.stringify(g2))
  live('sentence 2 starts to the right of sentence 1 on the shared line',
    g1.length > 0 && g2.length > 0 && g2[0].x > g1[0].x,
    's1[0].x=' + (g1[0] && g1[0].x) + ' s2[0].x=' + (g2[0] && g2[0].x))
  live('sentence 2 ends lower down the paragraph than sentence 1',
    g1.length > 0 && g2.length > 0 &&
    g2[g2.length - 1].y > g1[g1.length - 1].y,
    's1 last y=' + (g1.length && g1[g1.length - 1].y) +
    ' s2 last y=' + (g2.length && g2[g2.length - 1].y))
  const plongLines = await page.evaluate(() => window.__lineCount('plong'))
  live('the long paragraph really does wrap over several lines', plongLines >= 4,
    'lines=' + plongLines)
  live('a sentence highlight covers fewer lines than the whole paragraph',
    g1.length < plongLines, 'sentence lines=' + g1.length + ' paragraph lines=' + plongLines)
  await moveOff()

  // ── click to seek ─────────────────────────────────────────────────────────
  await reset()
  let p = await pointAt('plong', 'The second sentence develops')
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  let target = await seek()
  live('clicking a sentence records a seek target', target != null, JSON.stringify(target))
  live('the seek target is the block that was clicked', target && target.id === 'plong',
    JSON.stringify(target))
  live('the seek target carries that exact sentence',
    target && target.sentenceText ===
      'The second sentence develops the same idea a good deal further and carries on well past the end of the line it started on.',
    JSON.stringify(target && target.sentenceText))
  let sent = await calls()
  live('clicking sends stop then playTab', JSON.stringify(sent) === '["stop","playTab"]',
    JSON.stringify(sent))
  live('both messages are addressed to the service worker',
    (await page.evaluate(() => window.__calls())).every(m => m.dest === 'serviceWorker'))

  // clicking a different sentence of the same block seeks to that sentence
  await reset()
  p = await pointAt('plong', 'The fourth and final sentence')
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  target = await seek()
  live('clicking a later sentence seeks to that sentence, not the block start',
    target && target.id === 'plong' && /^The fourth and final sentence/.test(target.sentenceText || ''),
    JSON.stringify(target))

  // ── a citation marker between the full stop and the space ─────────────────
  // html-doc.js drops <sup> before the engine sees the text, so the overlay has
  // to drop it as well. Reading textContent instead left the stop with no
  // whitespace behind it, which merged both sentences into one hover target: the
  // second could not be picked and clicking it started reading from the first.
  await reset()
  p = await pointAt('pcite', 'For specific usage domains')
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  target = await seek()
  live('a sentence after a citation marker is its own seek target',
    target && target.id === 'pcite' && /^For specific usage domains/.test(target.sentenceText || ''),
    JSON.stringify(target))
  live('the citation marker is not part of the text handed to the engine',
    target && !/citation needed/.test(target.sentenceText || ''),
    JSON.stringify(target))

  await reset()
  p = await pointAt('pcite', 'Systems differ in the size')
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  target = await seek()
  live('the sentence before the marker stops at the full stop',
    target && /^Systems differ in the size/.test(target.sentenceText || '') &&
      /clarity\.$/.test(target.sentenceText || ''),
    JSON.stringify(target))

  // and the hover preview covers only that sentence, not both of them. The
  // merged target began at the top of the paragraph, so the test is that nothing
  // is painted above the line the cursor is actually on.
  await reset()
  const citeAt = await pointAt('pcite', 'For specific usage domains')
  const citeHover = await hoverAt('pcite', 'For specific usage domains')
  live('the sentence being pointed at is not the first line of the paragraph',
    citeAt.rect.top > await page.evaluate(
      () => document.getElementById('pcite').getBoundingClientRect().top) + 2,
    JSON.stringify(citeAt.rect))
  live('hovering after the marker highlights that sentence only',
    citeHover.rects.length > 0 && citeHover.rects.every(r => r.y >= citeAt.rect.top - 3),
    JSON.stringify({ rects: citeHover.rects, needleTop: citeAt.rect.top }))
  await moveOff()

  // clicking an <li> seeks to that item
  await reset()
  p = await pointAt('li2', 'Models became small enough')
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  target = await seek()
  live('clicking a list item seeks to that <li>', target && target.id === 'li2',
    JSON.stringify(target))

  // A <p> nested inside a <blockquote>: scanBlocks()'s walk() stops descending at
  // the first BLOCK_TAG, so the blockquote is the block and the inner <p> is never
  // counted. Clicking inside the <p> must therefore resolve to the <blockquote>.
  await reset()
  p = await pointAt('bqp', 'Quoted sentence two goes here.')
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  target = await seek()
  live('a block nested in another block is not counted separately',
    target && target.tag === 'blockquote' && target.id === 'bq', JSON.stringify(target))
  live('the nested case still resolves the right sentence',
    target && target.sentenceText === 'Quoted sentence two goes here.',
    JSON.stringify(target && target.sentenceText))

  // The 10-character <p> is not a block. blockFromPoint() does not give up when
  // the walk finds nothing -- it falls through to "nearest block by vertical
  // centre" -- so clicking it seeks to a neighbour. Pinned as it is today.
  await reset()
  const shortPoint = await page.evaluate(() => {
    const el = document.getElementById('p2')
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2) }
  })
  await page.mouse.click(shortPoint.x, shortPoint.y)
  await page.waitForTimeout(300)
  target = await seek()
  live('clicking a sub-MIN_TEXT paragraph never seeks to it',
    target == null || target.id !== 'p2', JSON.stringify(target))

  // ── click is suppressed ───────────────────────────────────────────────────
  await reset()
  const link2 = await page.evaluate(() => {
    const el = document.getElementById('thelink')
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  })
  await page.mouse.click(link2.x, link2.y)
  await page.waitForTimeout(300)
  live('clicking an inline link records no seek target', (await seek()) == null,
    JSON.stringify(await seek()))
  live('clicking an inline link sends nothing', (await calls()).length === 0,
    JSON.stringify(await calls()))

  // A plain click cannot test the selection guard: mousedown collapses any
  // existing selection, so the guard only bites on a drag, where the selection is
  // still alive at pointerup.
  await reset()
  await page.evaluate(() => window.getSelection().removeAllRanges())
  p = await pointAt('plong', 'A third sentence turns up')
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + 230, p.y, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const selected = await page.evaluate(() => String(window.getSelection()).trim())
  live('the drag produced a text selection', selected.length > 5, JSON.stringify(selected))
  live('drag-selecting text records no seek target', (await seek()) == null,
    JSON.stringify(await seek()))
  live('drag-selecting text sends nothing', (await calls()).length === 0,
    JSON.stringify(await calls()))
  await page.evaluate(() => window.getSelection().removeAllRanges())

  // ── rescan on DOM mutation ────────────────────────────────────────────────
  // New content must become hoverable and clickable without a reload. The
  // MutationObserver debounces 500 ms, so nothing is expected before then.
  await reset()

  // A rescan walks the whole document, so it is gated on the page having actually
  // changed by a meaningful amount. One stray paragraph must not pay for it.
  await page.evaluate(() => {
    const el = document.createElement('p')
    el.id = 'lonely'
    el.style.margin = '80px 0'
    el.textContent = 'A single stray paragraph, long enough to be readable on its own.'
    document.getElementById('dynamic').appendChild(el)
  })
  await page.waitForTimeout(900)
  const lonely = await hoverAt('lonely', 'A single stray paragraph')
  live('one stray paragraph does not trigger a rescan', lonely.rects.length === 0,
    'rects=' + lonely.rects.length)
  await moveOff()

  await reset()
  await page.evaluate(() => {
    const host = document.getElementById('dynamic')
    host.style.margin = '80px 0'
    for (let i = 0; i < 8; i++) {
      const el = document.createElement('p')
      el.id = 'late' + i
      el.style.margin = '80px 0'
      el.textContent = 'Late paragraph number ' + i +
        ', appended long after the initial scan and long enough to count as readable content.'
      host.appendChild(el)
    }
  })
  const early = await hoverAt('late1', 'Late paragraph number 1')
  live('newly appended content is not hoverable before the debounce elapses',
    early.rects.length === 0, 'rects=' + early.rects.length)
  await moveOff()
  await page.waitForTimeout(900)   // 500 ms debounce + slack

  const late = await hoverAt('late1', 'Late paragraph number 1')
  live('newly appended content is hoverable after the rescan', late.rects.length > 0,
    'rects=' + late.rects.length + ' point=' + JSON.stringify(late.point))
  await moveOff()

  await reset()
  p = await pointAt('late1', 'Late paragraph number 1')
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  target = await seek()
  live('newly appended content is clickable after the rescan',
    target && target.id === 'late1', JSON.stringify(target))
  live('the rescan did not break messaging',
    JSON.stringify(await calls()) === '["stop","playTab"]', JSON.stringify(await calls()))

  // the rescan drops both overlays, and the poll must recover the highlight
  await page.evaluate(() => {
    window.__fakeState = {
      state: 'PLAYING',
      speechInfo: { texts: [document.getElementById('late2').textContent], position: { index: 0 } }
    }
    document.getElementById('late2').scrollIntoView({ block: 'center', behavior: 'instant' })
  })
  await page.waitForTimeout(1500)   // idle poll is 1000ms; allow a full cycle plus slack
  const lateRects = await playRects()
  live('the playback highlight can find newly appended content',
    lateRects.length > 0 && await page.evaluate(rs => window.__rectsOver(rs, 'late2'), lateRects),
    JSON.stringify(lateRects))
  await page.evaluate(() => { window.__fakeState = { state: 'STOPPED' } })
  await page.waitForTimeout(500)

  // ── swapped-out content still forces a rescan ─────────────────────────────
  // Replacing content one-for-one leaves the candidate count untouched, so the
  // 15% delta gate says nothing changed and only the staleness check can notice.
  // The replacements sit at the tail of the index, which is exactly where a
  // prefix sample cannot see them — measured on a real Wikipedia article, 151 of
  // 503 indexed blocks were detached and all of them sat past position 345.
  await reset()
  await page.evaluate(() => {
    const host = document.getElementById('dynamic')
    for (let i = 0; i < 8; i++) {
      const old = document.getElementById('late' + i)
      const el = document.createElement('p')
      el.id = 'late' + i
      el.style.margin = '80px 0'
      el.textContent = 'Swapped paragraph number ' + i +
        ', a fresh node replacing the one the overlay already indexed.'
      old.replaceWith(el)
    }
  })
  await page.waitForTimeout(900)   // 500 ms debounce + slack
  const swapped = await hoverAt('late1', 'Swapped paragraph number 1')
  live('one-for-one replacement at the tail of the index still triggers a rescan',
    swapped.rects.length > 0, 'rects=' + swapped.rects.length)
  await moveOff()

  await reset()
  p = await pointAt('late1', 'Swapped paragraph number 1')
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  target = await seek()
  live('the replacement node — not the detached one — is what a click seeks to',
    target && target.id === 'late1' && /^Swapped paragraph number 1/.test(target.sentenceText),
    JSON.stringify(target))

  // A detached block keeps answering indexOf with the text it used to hold. The
  // playback search must skip it and find the live node instead.
  await page.evaluate(() => {
    window.__fakeState = {
      state: 'PLAYING',
      speechInfo: { texts: [document.getElementById('late2').textContent], position: { index: 0 } }
    }
    document.getElementById('late2').scrollIntoView({ block: 'center', behavior: 'instant' })
  })
  await page.waitForTimeout(1500)
  const swapRects = await playRects()
  live('the playback highlight lands on the replacement node',
    swapRects.length > 0 && await page.evaluate(rs => window.__rectsOver(rs, 'late2'), swapRects),
    JSON.stringify(swapRects))
  await page.evaluate(() => { window.__fakeState = { state: 'STOPPED' } })
  await page.waitForTimeout(500)

  // ── the same thing on a page big enough that the sample strides ───────────
  // Everything above runs on a fixture of ~19 blocks, where the staleness sample
  // covers every one of them. The Wikipedia article that turned this up had 503,
  // where the sample takes every 15th — so the stride is only ever exercised by a
  // large page, and an off-by-one there would go unnoticed on the small fixture.
  await reset()
  await page.evaluate(() => {
    const host = document.getElementById('dynamic')
    const bulk = document.createElement('div')
    bulk.id = 'bulk'
    for (let i = 0; i < 400; i++) {
      const el = document.createElement('p')
      el.id = 'bulk' + i
      el.textContent = 'Bulk paragraph number ' + i +
        ', one of many, long enough to be counted as readable content.'
      bulk.appendChild(el)
    }
    host.appendChild(bulk)
  })
  await page.waitForTimeout(900)
  const bulkHover = await hoverAt('bulk390', 'Bulk paragraph number 390')
  live('a 400-paragraph insert is indexed', bulkHover.rects.length > 0,
    'rects=' + bulkHover.rects.length)
  await moveOff()

  // Swap out a quarter of them, one for one, near the tail: the candidate count
  // does not move, so only the strided staleness sample can catch this.
  await reset()
  await page.evaluate(() => {
    for (let i = 300; i < 400; i++) {
      const old = document.getElementById('bulk' + i)
      const el = document.createElement('p')
      el.id = 'bulk' + i
      el.textContent = 'Replaced bulk paragraph number ' + i +
        ', a fresh node standing in for one already indexed.'
      old.replaceWith(el)
    }
  })
  await page.waitForTimeout(900)
  const bulkSwap = await hoverAt('bulk390', 'Replaced bulk paragraph number 390')
  live('a tail-region swap on a 400-block page still triggers a rescan',
    bulkSwap.rects.length > 0, 'rects=' + bulkSwap.rects.length)
  await moveOff()
  await page.evaluate(() => document.getElementById('bulk').remove())
  await page.waitForTimeout(900)

  live('no page errors or console errors at any point', errors.length === 0,
    errors.slice(0, 5).join('\n         '))

  console.log(`\n${name}: harness ${done.pass} passed / ${done.fail} failed;` +
    ` live ${livePass} passed / ${liveFail} failed`)
  if (done.error) { console.log('harness error: ' + done.error); totalFail++ }
  totalFail += done.fail + liveFail
  summary.push({ name, pass: done.pass + livePass, fail: done.fail + liveFail })

  await browser.close()
}

server.close()
console.log('\n' + '='.repeat(64))
for (const s of summary) console.log(`${s.name.padEnd(10)} ${s.pass} passed, ${s.fail} failed`)
console.log(totalFail ? `\nTOTAL FAILURES: ${totalFail}` : '\nALL GREEN on both engines')
process.exit(totalFail ? 1 : 0)
