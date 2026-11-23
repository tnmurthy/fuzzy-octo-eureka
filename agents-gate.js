'use strict';
// Blocks every way to start an agent on a portal that has no Cloudflare Access
// app of its own (P0.2). Without Access, the portal's shared password is the
// only lock, and agents run code on this Mac. Requests made at this Mac (no
// tunnel) are unaffected. Set ACCESS_AUD for the portal to lift the block.

const AGENT_PATHS = [
  /^\/agents(\.html|\/.*)?$/,
  /^\/api\/agents\//,
  /^\/api\/dispatch\//,
  /^\/api\/team\/dispatch/,
  /^\/api\/patrol\//,
  /^\/api\/agent\/chat/, // chat can auto-dispatch an agent
];

/** @param {string} url request url, may include a query */
function isAgentPath(url) {
  const p = String(url || '').split('?')[0];
  return AGENT_PATHS.some((re) => re.test(p));
}

/**
 * @param {{ portalHasAccess: boolean, viaTunnel: boolean, url: string }} o
 * @returns {boolean} true when the request must be refused
 */
function agentsBlocked({ portalHasAccess, viaTunnel, url }) {
  if (portalHasAccess || !viaTunnel) return false;
  return isAgentPath(url);
}

const BLOCK_MESSAGE =
  'Agents are switched off on this portal until it is protected by Cloudflare Access.';

module.exports = { agentsBlocked, isAgentPath, BLOCK_MESSAGE };
