import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseReflogLine, classifyReflogEvent } from '../src/classifier.js';

describe('Classifier & Reflog Parser', () => {
  it('parses standard git reflog line', () => {
    const line = 'a1b2c3d4e5f6 1234567890ab John Doe <john@example.com> 1725712345 +0300\tupdate by push';
    const parsed = parseReflogLine(line);

    assert.ok(parsed);
    assert.equal(parsed.oldSha, 'a1b2c3d4e5f6');
    assert.equal(parsed.newSha, '1234567890ab');
    assert.equal(parsed.author, 'John Doe');
    assert.equal(parsed.email, 'john@example.com');
    assert.equal(parsed.message, 'update by push');
  });

  it('classifies remote push event', () => {
    const line = '000000000000 abcdef123456 John Doe <john@example.com> 1725712345 +0300\tupdate by push';
    const parsed = parseReflogLine(line);
    const event = classifyReflogEvent('/workspace/http/.git/logs/refs/remotes/origin/main', parsed);

    assert.ok(event);
    assert.equal(event.trigger, 'push');
    assert.equal(event.branch, 'main');
    assert.equal(event.remote, 'origin');
    assert.equal(event.sha, 'abcdef123456');
  });

  it('classifies remote fetch event', () => {
    const line = '111111111111 222222222222 John Doe <john@example.com> 1725712345 +0300\tfetch origin main:main';
    const parsed = parseReflogLine(line);
    const event = classifyReflogEvent('/workspace/http/.git/logs/refs/remotes/origin/main', parsed);

    assert.ok(event);
    assert.equal(event.trigger, 'fetch');
    assert.equal(event.branch, 'main');
  });

  it('classifies local commit event', () => {
    const line = '111111111111 222222222222 John Doe <john@example.com> 1725712345 +0300\tcommit: update readme';
    const parsed = parseReflogLine(line);
    const event = classifyReflogEvent('/workspace/http/.git/logs/refs/heads/feature', parsed);

    assert.ok(event);
    assert.equal(event.trigger, 'commit');
    assert.equal(event.branch, 'feature');
  });

  it('returns null for empty or invalid lines', () => {
    assert.equal(parseReflogLine(''), null);
    assert.equal(parseReflogLine('invalid line without tab'), null);
    assert.equal(classifyReflogEvent('/invalid/path', null), null);
  });
});
