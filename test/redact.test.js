import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redact.js';

test('a token inside a git remote URL is masked', () => {
  const line =
    'https://github_pat_11ABG65HY0opWkBIoVUAuW_JFmq79ryjZ:x-oauth-basic@github.com/acme/acme-api.git';
  const out = redact(line);
  assert.ok(!out.includes('github_pat_11ABG65'));
  assert.ok(!out.includes('JFmq79ryjZ'));
  assert.match(out, /https:\/\/\*\*\*@github\.com/);
});

test('a bare GitHub PAT is masked', () => {
  assert.equal(
    redact('token: github_pat_11ABCDEFG0abcdefghijklmno_pqrstuvwxyz012345'),
    'token: github_pat_***'
  );
  assert.equal(redact('ghp_abcdefghijklmnop0123456789ABCDEF'), 'gh*_***');
});

test('Authorization header and _authToken', () => {
  assert.equal(redact('Authorization: Bearer eyJhbGciOi.abc.def'), 'Authorization: Bearer ***');
  assert.equal(redact('//registry.npmjs.org/:_authToken=npm_secretsecret'), '//registry.npmjs.org/:_authToken=***');
});

test('normal text is unchanged', () => {
  const s = 'command failed (yarn upgrade @acme/api): exit code 1';
  assert.equal(redact(s), s);
});

test('empty input', () => {
  assert.equal(redact(''), '');
  assert.equal(redact(undefined), undefined);
});
