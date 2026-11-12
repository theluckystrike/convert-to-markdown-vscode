'use strict';
// REACH1 (lane NEWSHIP): this listing's Pro tools for the toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  "prefix": "toMarkdown",
  "triesKey": "toMarkdown.proTrial",
  "slot": "",
  "tools": [
    {
      "id": "folder",
      "title": "Convert a Folder to Markdown",
      "command": "toMarkdown.convertFolder"
    },
    {
      "id": "images",
      "title": "Convert to Markdown with Images",
      "command": "toMarkdown.convertWithImages"
    },
    {
      "id": "llm",
      "title": "Convert to LLM-ready Markdown Chunks",
      "command": "toMarkdown.convertForLlm"
    }
  ]
};
