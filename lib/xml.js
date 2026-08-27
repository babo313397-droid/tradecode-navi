// Small regex-based XML reader for UniPass's flat response structures.
// Tag-name boundary lookahead (?=[\s/>]) prevents "trrt" from matching inside
// "trrtTpcd" / "trrtTpNm" etc.
function extractTag(str, tag) {
  const openRe = new RegExp(`<${tag}(?=[\\s/>])[^>]*>`);
  const openMatch = str.match(openRe);
  if (!openMatch) return null;
  if (openMatch[0].endsWith('/>')) return ''; // self-closing -> empty value
  const startIdx = openMatch.index + openMatch[0].length;
  const closeIdx = str.indexOf(`</${tag}>`, startIdx);
  if (closeIdx === -1) return null;
  return str.slice(startIdx, closeIdx).trim();
}

function extractBlocks(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

module.exports = { extractTag, extractBlocks };
