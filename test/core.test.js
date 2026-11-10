'use strict';
// Pure helpers: Markdown escaping and tables, format detection, LLM chunks and front matter.
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/md');
const { detect, zipNames } = require('../src/core/detect');
const llm = require('../src/core/llm');
const B = require('./build');

test('escaping keeps text as text: emphasis, links, HTML, line starts; snake_case stays readable', () => {
  assert.strictEqual(M.escapeText('a *b* [c](d) <img> snake_case _x_'), 'a \\*b\\* \\[c\\](d) \\<img\\> snake_case \\_x\\_');
  assert.strictEqual(M.escapeLine('# not a heading'), '\\# not a heading');
  assert.strictEqual(M.escapeLine('1. not a list'), '1\\. not a list');
  assert.strictEqual(M.escapeLine('- not a bullet'), '\\- not a bullet');
});

test('pipe tables: header, padding of short rows, pipes and newlines in cells', () => {
  assert.strictEqual(M.table([['a', 'b'], ['1|2'], ['x\ny', 'z']]), '| a | b |\n| --- | --- |\n| 1\\|2 |  |\n| x<br>y | z |');
  assert.strictEqual(M.table([]), '');
  assert.strictEqual(M.safeName('a/b:c*?.md'), 'a-b-c-.md');
});

test('detect: every format by its bytes, refusals by name', () => {
  assert.strictEqual(detect(B.samplePdf(), 'x.bin').kind, 'pdf');
  assert.strictEqual(detect(B.sampleDocx(), 'x.zip').kind, 'docx');
  assert.strictEqual(detect(B.samplePptx(), 'x').kind, 'pptx');
  assert.strictEqual(detect(B.sampleXlsx(), 'x').kind, 'xlsx');
  assert.strictEqual(detect(B.sampleOdt(), 'x').kind, 'odt');
  assert.strictEqual(detect(B.sampleEpub(), 'x').kind, 'epub');
  assert.strictEqual(detect(B.sampleRtf(), 'x.doc').kind, 'rtf');
  assert.strictEqual(detect(B.sampleHtml(), 'page.txt').kind, 'html');
  assert.strictEqual(detect(B.sampleCsv(), 'a.csv').kind, 'csv');
  assert.strictEqual(detect(Buffer.alloc(0), 'a.pdf').kind, 'empty');
  assert.strictEqual(detect(B.zip({ 'a.txt': 'x' }), 'a.docx').kind, 'zip-unknown');
  assert.strictEqual(detect(Buffer.from('hello'), 'a.docx').kind, 'unknown');
  const names = zipNames(B.sampleDocx());
  assert.ok(names.includes('word/document.xml'));
});

test('detect: a ZIP whose header says one XML part is 300 MB is refused as a ZIP bomb', () => {
  const z = B.zip([['word/document.xml', '<w:document/>', { fakeSize: 300 * 1024 * 1024 }]]);
  assert.strictEqual(detect(z, 'a.docx').kind, 'zip-bomb');
});

test('LLM chunks: split at headings with the heading path, long sections cut at paragraphs, code blocks kept whole', () => {
  const para = 'word '.repeat(120).trim(); // 599 chars, about 150 tokens
  const md = `# Guide\n\nIntro text.\n\n## Install\n\n${para}\n\n${para}\n\n${para}\n\n\`\`\`sh\n# not a heading\nnpm test\n\`\`\`\n\n## Use\n\nShort.\n`;
  const c = llm.chunk(md, { maxTokens: 200 });
  assert.strictEqual(c[0].heading, 'Guide');
  assert.deepStrictEqual(c[0].path, ['Guide']);
  const install = c.filter((x) => x.heading.startsWith('Install'));
  assert.ok(install.length >= 2, JSON.stringify(c.map((x) => [x.heading, x.tokens])));
  assert.deepStrictEqual(install[0].path, ['Guide', 'Install']);
  assert.ok(install.every((x) => x.tokens <= 400));
  assert.ok(c.some((x) => x.text.includes('```sh\n# not a heading\nnpm test\n```')), 'code block whole');
  assert.ok(!c.some((x) => x.heading === 'not a heading'));
  assert.strictEqual(c.at(-1).heading, 'Use');
  assert.deepStrictEqual(c.map((x) => x.index), c.map((_, i) => i + 1));
  assert.strictEqual(llm.estimateTokens('abcdefgh'), 2);
});

test('front matter is valid YAML-style quoted text; JSONL has one parseable record per chunk', () => {
  const fm = llm.frontMatter({ title: 'A "quoted": title', source: 'deck.pptx', slides: 3, empty: '', headings: ['A', 'B: c'] });
  assert.strictEqual(fm, '---\ntitle: "A \\"quoted\\": title"\nsource: "deck.pptx"\nslides: 3\nheadings: ["A", "B: c"]\n---\n');
  const chunks = llm.chunk('# A\n\none\n\n# B\n\ntwo\n');
  const lines = llm.toJsonl(chunks, { source: 'x.pdf', title: 'X', converted: '2026-11-10T00:00:00.000Z' }).trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(Object.keys(lines[0]), ['id', 'source', 'title', 'chunk', 'chunks', 'heading', 'headings', 'tokens_estimate', 'converted', 'text']);
  assert.strictEqual(lines[1].id, 'x.pdf#2');
  const files = llm.chunkFiles(chunks, { title: 'X', source: 'x.pdf' });
  assert.strictEqual(files[0].name, '001.md');
  assert.match(files[0].text, /^---\ntitle: "X"\nsource: "x.pdf"\nchunk: 1\nchunks: 2\nheading: "A"\nheadings: \["A"\]\ntokens_estimate: \d+\n---\n\n# A\n\none\n$/);
});
