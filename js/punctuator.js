/**
 * Sentence/phrase/word splitting, shared between the speech engine and the page.
 *
 * These were private to `Speech()` in js/speech.js, which meant a content script
 * could not reach them and had to carry its own regex. Two splitters that disagree
 * is a real bug and not a cosmetic one: the in-page overlay resolves a click to a
 * sentence and then asks the engine to start there, so if the two draw sentence
 * boundaries differently, reading starts in the wrong place.
 *
 * Moved here verbatim so there is exactly one implementation. js/speech.js now uses
 * these globals; player.html loads this file before speech.js, and the content
 * script list loads it before hover-overlay.js.
 */

function LatinPunctuator() {
  this.getParagraphs = function(text) {
    return recombine(text.split(/((?:\r?\n\s*){2,})/));
  }
  this.getSentences = function(text) {
    return recombine(text.split(/([.!?]+[\s\u200b]+)/), /\b(\w|[A-Z][a-z]|Assn|Ave|Capt|Col|Comdr|Corp|Cpl|Gen|Gov|Hon|Inc|Lieut|Ltd|Rev|Univ|Jan|Feb|Mar|Apr|Aug|Sept|Oct|Nov|Dec|dept|ed|est|vol|vs)\.\s+$/);
  }
  this.getPhrases = function(sentence) {
    return recombine(sentence.split(/([,;:]\s+|\s-+\s+|—\s*)/));
  }
  this.getWords = function(sentence) {
    var tokens = sentence.split(/([~@#%^*_+=<>]|[\s\-—/]+|\.(?=\w{2,})|,(?=[0-9]))/);
    var result = [];
    for (var i=0; i<tokens.length; i+=2) {
      if (tokens[i]) result.push(tokens[i]);
      if (i+1 < tokens.length) {
        if (/^[~@#%^*_+=<>]$/.test(tokens[i+1])) result.push(tokens[i+1]);
        else if (result.length) result[result.length-1] += tokens[i+1];
      }
    }
    return result;
  }
  function recombine(tokens, nonPunc) {
    var result = [];
    for (var i=0; i<tokens.length; i+=2) {
      var part = (i+1 < tokens.length) ? (tokens[i] + tokens[i+1]) : tokens[i];
      if (part) {
        if (nonPunc && result.length && nonPunc.test(result[result.length-1])) result[result.length-1] += part;
        else result.push(part);
      }
    }
    return result;
  }
}

function EastAsianPunctuator() {
  this.getParagraphs = function(text) {
    return recombine(text.split(/((?:\r?\n\s*){2,})/));
  }
  this.getSentences = function(text) {
    return recombine(text.split(/([.!?]+[\s\u200b]+|[\u3002\uff01]+)/));
  }
  this.getPhrases = function(sentence) {
    return recombine(sentence.split(/([,;:]\s+|[\u2025\u2026\u3000\u3001\uff0c\uff1b]+)/));
  }
  this.getWords = function(sentence) {
    return sentence.replace(/\s+/g, "").split("");
  }
  function recombine(tokens) {
    var result = [];
    for (var i=0; i<tokens.length; i+=2) {
      if (i+1 < tokens.length) result.push(tokens[i] + tokens[i+1]);
      else if (tokens[i]) result.push(tokens[i]);
    }
    return result;
  }
}

/**
 * The sentences of `text`, each with its offset within `text`.
 *
 * Offsets are what make this usable from the page: a sentence offset can be turned
 * into a DOM Range, and it is the same coordinate space the engine will chunk in.
 * Both splitters are lossless -- their pieces concatenate back to the input -- so a
 * running length gives exact offsets. `verifySplitterIsLossless` below asserts that
 * property rather than assuming it.
 *
 * @param {string} text
 * @param {string} [lang] BCP-47-ish; zh/ko/ja select the East Asian rules
 */
function getSentencesWithOffsets(text, lang) {
  if (!text) return [];
  var punctuator = /^(zh|ko|ja)/.test(lang || "") ? new EastAsianPunctuator() : new LatinPunctuator();
  var pieces = punctuator.getSentences(text);
  var out = [];
  var offset = 0;
  for (var i = 0; i < pieces.length; i++) {
    var piece = pieces[i];
    if (piece.trim()) out.push({text: piece.trim(), raw: piece, start: offset, end: offset + piece.length});
    offset += piece.length;
  }
  //A splitter that dropped or duplicated characters would silently shift every
  //offset after the damage. Fall back to treating the whole text as one sentence
  //rather than seeking to the wrong place.
  if (offset !== text.length) {
    return [{text: text.trim(), raw: text, start: 0, end: text.length}];
  }
  return out;
}
