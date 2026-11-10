'use strict';
// LLM-ready output (Zovo Pro): YAML front matter, chunks split at headings with a token estimate each, written as one
// Markdown file per chunk or as one JSONL file. The estimate is characters / 4, the usual rule of thumb for English
// text with GPT-style tokenizers; it is labelled as an estimate everywhere.

const estimateTokens = (s) => Math.ceil(String(s).length / 4);

function yamlValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) return `[${v.map(yamlValue).join(', ')}]`;
  return JSON.stringify(String(v)); // a JSON string is a valid YAML double-quoted scalar
}

function frontMatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') lines.push(`${k}: ${yamlValue(v)}`);
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Split Markdown at headings (levels 1 to splitLevel). A section longer than maxTokens is cut at blank lines
 * (never inside a code block). Returns [{ heading, path, text, tokens }].
 */
function chunk(markdown, { maxTokens = 800, splitLevel = 3 } = {}) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  const pathStack = [];
  let cur = { heading: '', path: [], lines: [] };
  let fence = null;
  for (const line of lines) {
    const f = /^(\s{0,3})(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) fence = f[2][0].repeat(f[2].length); else if (line.trim().startsWith(fence)) fence = null; }
    const h = !fence && /^(#{1,6})\s+(.*)$/.exec(line);
    if (h && h[1].length <= splitLevel) {
      if (cur.lines.some((l) => l.trim())) sections.push(cur);
      const level = h[1].length;
      const text = h[2].replace(/\\(.)/g, '$1').trim();
      pathStack.length = level - 1;
      pathStack[level - 1] = text;
      cur = { heading: text, path: pathStack.filter(Boolean), lines: [line] };
      continue;
    }
    cur.lines.push(line);
  }
  if (cur.lines.some((l) => l.trim())) sections.push(cur);
  const out = [];
  for (const s of sections) {
    const text = s.lines.join('\n').trim();
    if (estimateTokens(text) <= maxTokens) { out.push({ heading: s.heading, path: s.path, text }); continue; }
    // cut at blank lines outside code blocks
    const paras = [];
    let buf = [], inFence = null;
    for (const line of s.lines) {
      const f = /^(\s{0,3})(`{3,}|~{3,})/.exec(line);
      if (f) { if (!inFence) inFence = f[2]; else if (line.trim().startsWith(inFence)) inFence = null; }
      if (!line.trim() && !inFence) { if (buf.length) paras.push(buf.join('\n')); buf = []; } else buf.push(line);
    }
    if (buf.length) paras.push(buf.join('\n'));
    let acc = '';
    let part = 1;
    const push = () => { if (acc.trim()) out.push({ heading: s.heading + (part > 1 ? ` (part ${part})` : ''), path: s.path, text: acc.trim() }); part++; acc = ''; };
    for (const p of paras) {
      if (acc && estimateTokens(acc + '\n\n' + p) > maxTokens) push();
      if (estimateTokens(p) > maxTokens * 2) { // one huge paragraph or table: hard cut by characters
        for (let i = 0; i < p.length; i += maxTokens * 4) { acc = p.slice(i, i + maxTokens * 4); push(); }
        continue;
      }
      acc = acc ? `${acc}\n\n${p}` : p;
    }
    push();
  }
  return out.map((c, i) => ({ index: i + 1, ...c, tokens: estimateTokens(c.text) }));
}

/** fields: { title, source, format, pages, slides, sheets, converted } */
function toJsonl(chunks, fields) {
  return chunks.map((c) => JSON.stringify({
    id: `${fields.source}#${c.index}`, source: fields.source, title: fields.title || '', chunk: c.index, chunks: chunks.length,
    heading: c.heading, headings: c.path, tokens_estimate: c.tokens, converted: fields.converted, text: c.text,
  })).join('\n') + '\n';
}

function chunkFiles(chunks, fields) {
  const width = String(chunks.length).length;
  return chunks.map((c) => ({
    name: `${String(c.index).padStart(Math.max(3, width), '0')}.md`,
    text: frontMatter({ ...fields, chunk: c.index, chunks: chunks.length, heading: c.heading, headings: c.path, tokens_estimate: c.tokens }) + '\n' + c.text + '\n',
  }));
}

module.exports = { chunk, frontMatter, toJsonl, chunkFiles, estimateTokens };
