'use strict';
const test = require('node:test');
const assert = require('node:assert');
const id = require('./identity');

test('Access email wins over the shared password login', () => {
  assert.deepStrictEqual(
    id.resolveUser({ accessVerdict: { ok: true, email: 'Asha@Example.com' }, sessionUser: 'sriad' }),
    { user: 'asha@example.com', via: 'access' }
  );
});

test('falls back to the password login when Access did not verify', () => {
  assert.deepStrictEqual(id.resolveUser({ accessVerdict: { ok: false }, sessionUser: 'drisyon' }), { user: 'drisyon', via: 'password' });
  assert.deepStrictEqual(id.resolveUser({ accessVerdict: null, sessionUser: 'sriad' }), { user: 'sriad', via: 'password' });
  assert.deepStrictEqual(id.resolveUser({ accessVerdict: { ok: true, email: '' }, sessionUser: 'sriad' }), { user: 'sriad', via: 'password' });
  assert.strictEqual(id.resolveUser({ accessVerdict: null, sessionUser: null }), null);
});

test('admin: local always; remote only when listed in ADMIN_USERS', () => {
  const adminUsers = id.parseAdminUsers(' Owner@Example.com , ');
  assert.deepStrictEqual(adminUsers, ['owner@example.com']);
  assert.strictEqual(id.isAdminUser({ local: true, user: null, adminUsers }), true);
  assert.strictEqual(id.isAdminUser({ local: false, user: 'owner@example.com', adminUsers }), true);
  assert.strictEqual(id.isAdminUser({ local: false, user: 'asha@example.com', adminUsers }), false);
  // shared logins are no longer admin unless named
  assert.strictEqual(id.isAdminUser({ local: false, user: 'sriad', adminUsers }), false);
  assert.strictEqual(id.isAdminUser({ local: false, user: 'drisyon', adminUsers }), false);
  assert.strictEqual(id.isAdminUser({ local: false, user: 'x', adminUsers: id.parseAdminUsers('') }), false);
});

test('tenant comes from the portal, not the person', () => {
  assert.strictEqual(id.tenantActor({ local: false, isDrisyonPortal: true }), 'user:drisyon');
  assert.strictEqual(id.tenantActor({ local: false, isDrisyonPortal: false }), 'user:sriad');
});

test('x-rebac-actor is ignored from remote callers, honoured at this Mac', () => {
  assert.strictEqual(id.tenantActor({ local: false, headerActor: 'user:sriad', isDrisyonPortal: true }), 'user:drisyon');
  assert.strictEqual(id.tenantActor({ local: true, headerActor: 'user:sriad', isDrisyonPortal: true }), 'user:sriad');
  assert.strictEqual(id.tenantActor({ local: true, headerActor: 'bogus value', isDrisyonPortal: false }), 'user:sriad');
});

test('portal names and run authors', () => {
  assert.strictEqual(id.portalName(true), 'drisyon');
  assert.strictEqual(id.portalName(false), 'team');
  assert.strictEqual(id.runAuthor('asha@example.com'), 'asha@example.com');
  assert.strictEqual(id.runAuthor(''), 'local operator');
  assert.strictEqual(id.runAuthor('x"; rm -rf /'), 'local operator');
});
