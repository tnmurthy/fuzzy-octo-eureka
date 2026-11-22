// static-policy.js - which files serveStaticFile may send.
//
// Before 2026-11-22 it sent any file under the dashboard folder, so
// GET /.env, /.env.drisyon, /logs/*.json and /drisyon-memory.json answered
// 200 to anyone past Cloudflare Access and to every local process.
// Allow-list: web assets at the top level, plus docs/. Nothing else.
'use strict';

const path = require('path');

const ROOT_EXT = new Set(['.html', '.css', '.js', '.ico', '.svg', '.png', '.jpg', '.jpeg', '.woff', '.woff2']);
const DOCS_EXT = new Set(['.md', '.png', '.jpg', '.jpeg', '.svg']);
const DENY_ROOT_FILES = new Set(['server.js', 'eslint.config.js', 'ecosystem.config.js']);

/** @param {string} urlPath decoded URL path, e.g. "/agents.html" */
function isServable(urlPath) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/') || urlPath.includes('\0')) return false;
  const parts = urlPath.split('/').filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((p) => p.startsWith('.') || p.includes('\\'))) return false; // dotfiles, "..", Windows separators
  const ext = path.extname(parts[parts.length - 1]).toLowerCase();
  if (parts.length === 1) return ROOT_EXT.has(ext) && !DENY_ROOT_FILES.has(parts[0]) && !parts[0].endsWith('.test.js');
  return parts[0] === 'docs' && DOCS_EXT.has(ext);
}

module.exports = { isServable };
