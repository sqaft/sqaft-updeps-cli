import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadState, saveState } from '../src/state.js';
import { generateMenubarOutput, commandClearErrors } from '../src/commands/menubar.js';

describe('Menubar Output & Error Management', () => {
  let originalState;

  before(() => {
    originalState = loadState();
  });

  after(() => {
    saveState(originalState);
  });

  it('returns empty string when no active runs and no errors (idle)', () => {
    saveState({
      ...originalState,
      activeRuns: [],
      errors: [],
      repos: {
        '/some/repo': { pendingPushCount: 5 }
      }
    });

    const output = generateMenubarOutput();
    assert.equal(output, '');
  });

  it('displays single running operation in header and dropdown', () => {
    saveState({
      ...originalState,
      activeRuns: [
        {
          id: 'source-pkg->target-pkg',
          sourceRepo: 'source-pkg',
          target: 'target-pkg',
          targetPath: '/path/to/target',
          startedAt: Date.now() - 5000
        }
      ],
      errors: []
    });

    const output = generateMenubarOutput();
    assert.ok(output.includes('🔄 target-pkg'));
    assert.ok(output.includes('Çalışan İşlemler (1)'));
    assert.ok(output.includes('source-pkg → target-pkg'));
    assert.ok(!output.includes('Push bekleyen'));
    assert.ok(!output.includes('Daemon:'));
  });

  it('displays multiple running operations in header and dropdown', () => {
    saveState({
      ...originalState,
      activeRuns: [
        {
          id: 'src1->tgt1',
          sourceRepo: 'src1',
          target: 'tgt1',
          targetPath: '/path/to/tgt1',
          startedAt: Date.now()
        },
        {
          id: 'src2->tgt2',
          sourceRepo: 'src2',
          target: 'tgt2',
          targetPath: '/path/to/tgt2',
          startedAt: Date.now()
        }
      ],
      errors: []
    });

    const output = generateMenubarOutput();
    assert.ok(output.includes('🔄 2 işlem çalışıyor'));
    assert.ok(output.includes('Çalışan İşlemler (2)'));
    assert.ok(output.includes('src1 → tgt1'));
    assert.ok(output.includes('src2 → tgt2'));
  });

  it('displays single failed operation in header and dropdown with details', () => {
    saveState({
      ...originalState,
      activeRuns: [],
      errors: [
        {
          id: 'src1->tgt1',
          sourceRepo: 'src1',
          target: 'tgt1',
          targetPath: '/path/to/tgt1',
          message: 'npm update failed with exit code 1',
          timestamp: Date.now() - 2000
        }
      ]
    });

    const output = generateMenubarOutput();
    assert.ok(output.includes('⚠️ tgt1 hata'));
    assert.ok(output.includes('Hata Veren İşlemler (1)'));
    assert.ok(output.includes('src1 → tgt1'));
    assert.ok(output.includes('npm update failed with exit code 1'));
    assert.ok(output.includes('Hataları Temizle'));
  });

  it('displays multiple failed operations in header', () => {
    saveState({
      ...originalState,
      activeRuns: [],
      errors: [
        {
          id: 'src1->tgt1',
          sourceRepo: 'src1',
          target: 'tgt1',
          targetPath: '/path/to/tgt1',
          message: 'error 1',
          timestamp: Date.now()
        },
        {
          id: 'src2->tgt2',
          sourceRepo: 'src2',
          target: 'tgt2',
          targetPath: '/path/to/tgt2',
          message: 'error 2',
          timestamp: Date.now()
        }
      ]
    });

    const output = generateMenubarOutput();
    assert.ok(output.includes('⚠️ 2 hata'));
    assert.ok(output.includes('Hata Veren İşlemler (2)'));
  });

  it('displays both running operations and errors when both exist', () => {
    saveState({
      ...originalState,
      activeRuns: [
        {
          id: 'src1->tgt1',
          sourceRepo: 'src1',
          target: 'tgt1',
          targetPath: '/path/to/tgt1',
          startedAt: Date.now()
        }
      ],
      errors: [
        {
          id: 'src2->tgt2',
          sourceRepo: 'src2',
          target: 'tgt2',
          targetPath: '/path/to/tgt2',
          message: 'error 2',
          timestamp: Date.now()
        }
      ]
    });

    const output = generateMenubarOutput();
    assert.ok(output.includes('🔄 1 çalışıyor · ⚠️ 1 hata'));
    assert.ok(output.includes('Çalışan İşlemler (1)'));
    assert.ok(output.includes('Hata Veren İşlemler (1)'));
  });

  it('clears errors with commandClearErrors', () => {
    saveState({
      ...originalState,
      errors: [{ id: 'err1', message: 'test' }]
    });

    commandClearErrors();
    const updated = loadState();
    assert.deepEqual(updated.errors, []);
  });
});
