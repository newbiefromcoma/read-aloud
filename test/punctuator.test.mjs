// js/punctuator.js holds the sentence splitter that both the speech engine and the
// in-page overlay use. It was lifted out of js/speech.js, where it was private to
// Speech() and therefore unreachable from a content script.
//
// Two things have to stay true or click-to-seek starts reading in the wrong place:
//
//   1. speech.js must not grow its own copy again. If it does, the two can drift
//      and nothing would say so.
//   2. getSentencesWithOffsets must be exact. The overlay turns those offsets into
//      a DOM Range and hands the sentence text to the engine to seek by, so an
//      off-by-anything puts the highlight and the audio in different places.
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0, fail = 0
function check(desc, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + desc) }
  else { fail++; console.log('  FAIL ' + desc + (extra ? '\n         ' + extra : '')) }
}

const punctuatorSrc = readFileSync(join(ROOT, 'js/punctuator.js'), 'utf8')
const P = new Function(punctuatorSrc + '\nreturn {LatinPunctuator, EastAsianPunctuator, getSentencesWithOffsets}')()

const speechSrc = readFileSync(join(ROOT, 'js/speech.js'), 'utf8')

console.log('\nthere is only one splitter:')
check('speech.js no longer defines LatinPunctuator',
  !/\bfunction LatinPunctuator\s*\(/.test(speechSrc))
check('speech.js no longer defines EastAsianPunctuator',
  !/\bfunction EastAsianPunctuator\s*\(/.test(speechSrc))
check('speech.js still constructs them (from the shared file)',
  /new LatinPunctuator\(\)/.test(speechSrc) && /new EastAsianPunctuator\(\)/.test(speechSrc))
check('player.html loads punctuator.js before speech.js', (() => {
  const html = readFileSync(join(ROOT, 'player.html'), 'utf8')
  const p = html.indexOf('js/punctuator.js')
  const s = html.indexOf('js/speech.js')
  return p !== -1 && s !== -1 && p < s
})())
check('the content script list loads punctuator.js before hover-overlay.js', (() => {
  const content = readFileSync(join(ROOT, 'js/content.js'), 'utf8')
  const line = content.split('\n').find(l => l.includes('hover-overlay.js'))
  if (!line) return false
  return line.indexOf('punctuator.js') !== -1 &&
         line.indexOf('punctuator.js') < line.indexOf('hover-overlay.js')
})())

// --- the corpus ---------------------------------------------------------------

const corpus = [
  'One two. Three four. Five six.',
  'Dr. Smith went to Washington. He arrived on Jan. 5 at 3 p.m.',
  'No terminal punctuation',
  'Ends in a question? Yes! Really.',
  'A url https://example.com/a.b sits here. Next sentence.',
  'Multiple   spaces.   And   more.',
  '',
  '   ',
  'Trailing space. ',
  'Assn. of things. Ave. Maria. Done.',
  'Ellipsis... then more. End.',
  'One sentence only',
  'Quote: "he said so." Then this.',
  'Numbers 3.14 and 2.71 stay together. Yes.',
]

console.log('\noffsets are exact:')
for (const text of corpus) {
  const label = JSON.stringify(text.slice(0, 30))
  const sentences = P.getSentencesWithOffsets(text)

  check('slices back to the source ' + label,
    sentences.every(s => text.slice(s.start, s.end) === s.raw),
    JSON.stringify(sentences))

  if (sentences.length) {
    check('lossless ' + label,
      sentences.map(s => s.raw).join('') === text,
      JSON.stringify(sentences.map(s => s.raw).join('')) + ' vs ' + JSON.stringify(text))
  }

  check('offsets are non-decreasing ' + label,
    sentences.every((s, i) => i === 0 || s.start >= sentences[i - 1].start))

  check('trimmed text is contained in the raw slice ' + label,
    sentences.every(s => s.raw.includes(s.text)))
}

console.log('\nsplitting behaviour:')
{
  const s = P.getSentencesWithOffsets('One two. Three four. Five six.')
  check('splits three sentences', s.length === 3, JSON.stringify(s.map(x => x.text)))
  check('first starts at 0', s[0].start === 0)
  check('each offset lands on its own text',
    s.every(x => 'One two. Three four. Five six.'.slice(x.start).trim().startsWith(x.text.slice(0, 8))),
    JSON.stringify(s))
}
{
  // the abbreviation list is what stops "Dr." ending a sentence
  const s = P.getSentencesWithOffsets('Dr. Smith arrived. He left.')
  check('an abbreviation does not end a sentence', s.length === 2, JSON.stringify(s.map(x => x.text)))
}
{
  const s = P.getSentencesWithOffsets('第一句。第二句。', 'zh-CN')
  check('East Asian rules split on the ideographic full stop',
    s.length === 2, JSON.stringify(s.map(x => x.text)))
  check('East Asian offsets are exact',
    s.every(x => '第一句。第二句。'.slice(x.start, x.end) === x.raw))
}
{
  const s = P.getSentencesWithOffsets('')
  check('empty text yields nothing', s.length === 0)
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
