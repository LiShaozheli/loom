import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileRef, checkRefs, applyStaleness, sha256 } from '../src/staleness.js';

test('fileRef + checkRefs：没变就是 fresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ref-'));
  const p = path.join(dir, 'config.yml');
  fs.writeFileSync(p, 'port: 8081\n', 'utf8');

  const ref = fileRef(p);
  assert.equal(ref.status, 'fresh');

  const [checked] = await checkRefs([ref]);
  assert.equal(checked.status, 'fresh');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件被改 → stale', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ref-'));
  const p = path.join(dir, 'a.txt');
  fs.writeFileSync(p, 'v1', 'utf8');
  const ref = fileRef(p);

  fs.writeFileSync(p, 'v2', 'utf8');
  const [checked] = await checkRefs([ref]);
  assert.equal(checked.status, 'stale');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('读不到 → unknown（不是 stale）', async () => {
  const [checked] = await checkRefs([{ kind: 'file', target: 'Z:/nope/none.txt', digest: 'abc' }]);
  assert.equal(checked.status, 'unknown');
});

test('repo / session 不假装知道', async () => {
  const out = await checkRefs([
    { kind: 'repo', target: 'github.com/x/y', digest: 'sha' },
    { kind: 'session', target: 'sess-1' },
  ]);
  assert.deepEqual(out.map((r) => r.status), ['unknown', 'unknown']);
});

test('url：给了 fetchEtag 才判，没给就 unknown', async () => {
  const noFetch = await checkRefs([{ kind: 'url', target: 'https://e.com', digest: 'W/"1"' }]);
  assert.equal(noFetch[0].status, 'unknown');

  const withFetch = await checkRefs([{ kind: 'url', target: 'https://e.com', digest: 'W/"1"' }], {
    fetchEtag: async () => 'W/"2"',
  });
  assert.equal(withFetch[0].status, 'stale');
});

test('applyStaleness：过时降权一半并打标', () => {
  assert.deepEqual(applyStaleness(1, 'stale'), { score: 0.5, flag: '可能过时' });
  assert.equal(applyStaleness(1, 'fresh').score, 1);
  assert.equal(applyStaleness(1, 'unknown').score, 0.9);
});

test('sha256 稳定', () => {
  assert.equal(sha256(Buffer.from('abc')), sha256(Buffer.from('abc')));
  assert.notEqual(sha256(Buffer.from('abc')), sha256(Buffer.from('abd')));
});
