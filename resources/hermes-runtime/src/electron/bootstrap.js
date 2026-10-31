'use strict';

/**
 * Module-resolution bootstrap for the source-built desktop shell.
 *
 * The original portable layout places shared production dependencies in
 * resources/app.asar.unpacked/node_modules. A normal source build lives outside
 * that archive, so register this directory (when present) before loading the
 * main process. The app continues to work with a self-contained node_modules
 * folder in a future clean package.
 */
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const candidates = [
  process.env.KNOCKDESK_NODE_MODULES,
  process.resourcesPath
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : null,
  path.resolve(__dirname, '../../../resources/app.asar.unpacked/node_modules'),
  path.resolve(__dirname, '../../../../../resources/app.asar.unpacked/node_modules'),
  path.join(__dirname, 'node_modules'),
].filter(Boolean);

const existing = candidates.filter((candidate) => {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
});

if (existing.length) {
  const allPaths = [...new Set([...existing, ...Module.globalPaths])];
  process.env.NODE_PATH = allPaths.join(path.delimiter);
  Module._initPaths();
}

require('./main.js');
