import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatAsciiGraph, detectCycles } from '../src/graph.js';

describe('Graph & Cycle Detection', () => {
  it('detects cycles between mutual dependents', () => {
    const config = {
      repos: [
        {
          path: '/workspace/a',
          name: 'a',
          packages: [{ path: '/workspace/b' }]
        },
        {
          path: '/workspace/b',
          name: 'b',
          packages: [{ path: '/workspace/a' }]
        }
      ]
    };

    const cycles = detectCycles(config);
    assert.equal(cycles.length, 1);
    assert.deepEqual(cycles[0], ['/workspace/a', '/workspace/b', '/workspace/a']);
  });

  it('formats ASCII graph properly', () => {
    const config = {
      repos: [
        {
          path: '/workspace/http',
          name: 'http',
          packages: [
            {
              path: '/workspace/client',
              name: 'client',
              triggers: ['push'],
              commands: ['npm update {pkgs}'],
              push: false
            }
          ]
        }
      ]
    };

    const ascii = formatAsciiGraph(config);
    assert.ok(ascii.includes('http'));
    assert.ok(ascii.includes('client'));
    assert.ok(ascii.includes('npm update {pkgs}'));
  });
});
