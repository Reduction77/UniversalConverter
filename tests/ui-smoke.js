const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

const pureRenderer = renderer.slice(0, renderer.indexOf('function formatSize'));
const samples = [
  ['video','mp4','mkv'], ['video','mov','mp4'],
  ['audio','mp3','m4a'], ['audio','wav','mp3'],
  ['image','jpg','png'], ['image','jpeg','png'], ['image','png','jpg'], ['image','webp','jpg'],
  ['document','docx','pdf'], ['document','xlsx','pdf'], ['document','pptx','pdf'],
  ['markup','md','pdf'], ['ebook','epub','pdf'], ['ebook','mobi','epub'],
  ['archive','zip','7z'], ['archive','7z','zip'], ['pdf','pdf','png'],
];
const sandbox = { samples, results: null };
vm.runInNewContext(`${pureRenderer}\nresults=samples.map(([category,ext])=>smartTarget({category,ext}));`, sandbox);
samples.forEach(([category, ext, expected], index) => {
  assert.strictEqual(sandbox.results[index], expected, `${category}.${ext} should recommend ${expected}`);
  assert.notStrictEqual(sandbox.results[index], ext, `${category}.${ext} must not recommend its source format`);
});

vm.runInNewContext(`
state.engines={ffmpeg:{available:true}};
results=[missingEngine({category:'audio',ext:'mp3'}),missingEngine({category:'image',ext:'png'})];
`,sandbox);
assert.equal(sandbox.results[0],null);
assert.equal(sandbox.results[1],'imagemagick');

assert.match(html, /class="index-col">序号/);
assert.match(html, /colspan="9"/);
assert.match(css, /table-wrap table\{width:max-content;min-width:100%;table-layout:auto\}/);
assert.match(css, /file-name-cell\{[^}]*max-width:none/);
assert.match(renderer, /document\.addEventListener\('dragover',[\s\S]*?preventDefault\(\)[\s\S]*?dropEffect='copy'/);
assert.match(renderer, /document\.addEventListener\('drop',[\s\S]*?getPathForFile/);
assert.match(renderer, /class="status-link"[\s\S]*?缺少引擎 →/);
assert.match(renderer, /goToEngine\(button\.dataset\.engine\)/);

console.log(`UI_SMOKE_OK ${samples.length} smart recommendations, scrollable queue, window-level drop, engine jump`);
