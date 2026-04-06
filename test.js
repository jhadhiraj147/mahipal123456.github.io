const JSDOM = require('jsdom').JSDOM;
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>');
// We can't really run quill in jsdom easily because of getBoundingClientRect etc.
