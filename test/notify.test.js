import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendNotification } from '../src/notify.js';

describe('Notification Service', () => {
  it('handles notification call without throwing', () => {
    assert.doesNotThrow(() => {
      sendNotification({
        type: 'ok',
        title: '@sqaft/updeps: test',
        message: '1 commit, 0 hata',
        enabled: true
      });
    });
  });

  it('respects enabled: false flag', () => {
    assert.doesNotThrow(() => {
      sendNotification({
        type: 'fail',
        title: '@sqaft/updeps: test',
        message: '1 hata',
        enabled: false
      });
    });
  });
});
