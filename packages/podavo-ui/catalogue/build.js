#!/usr/bin/env node
// Renders the component catalogue to catalogue/dist/index.html.
// Every component is shown in every state it supports; the page's switches (and
// ?theme= / ?variant= / ?density= in the URL) cover the design-system axes.
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'dist');
fs.mkdirSync(out, { recursive: true });

ejs.renderFile(path.join(__dirname, 'index.ejs'), { pkg: require('../package.json') }, {}, (err, html) => {
  if (err) { console.error(err); process.exit(1); }
  fs.writeFileSync(path.join(out, 'index.html'), html);
  console.log('Catalogue written to ' + path.relative(root, path.join(out, 'index.html')));
});
