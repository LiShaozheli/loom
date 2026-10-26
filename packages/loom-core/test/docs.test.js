import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteLedger } from '../src/sqlite-ledger.js';

const doc = (over = {}) => ({
  title: '发布流程',
  body: '第一步跑 smoke.sh；第二步灰度 10%；第三步观察 30 分钟再全量。',
  ...over,
});

test('写文档并取回', () => {
  const db = new SqliteLedger(':memory:');
  const d = db.putDoc(doc());
  assert.ok(d.id.startsWith('doc-'));
  assert.equal(db.getDoc(d.id).title, '发布流程');
  db.close();
});

test('同标题再写一次 = 更新，不是堆叠', () => {
  const db = new SqliteLedger(':memory:');
  const a = db.putDoc(doc());
  const b = db.putDoc(doc({ body: '改成了：先灰度再 smoke。' }));
  assert.equal(a.id, b.id);
  assert.equal(db.docs().length, 1);
  assert.ok(db.getDoc(a.id).body.includes('先灰度'));
  db.close();
});

test('文档检索：中文词可命中', () => {
  const db = new SqliteLedger(':memory:');
  db.putDoc(doc());
  db.putDoc({ title: '回滚手册', body: '回滚按钮在发布面板右上角，点了会回到上一个版本。' });

  const hits = db.searchDocs('回滚');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, '回滚手册');

  const hits2 = db.searchDocs('灰度');
  assert.ok(hits2.some((h) => h.title === '发布流程'));
  db.close();
});

test('长文不被 AI文 的长度规则限制', () => {
  const db = new SqliteLedger(':memory:');
  const long = '这一段很长的说明。'.repeat(200);
  const d = db.putDoc({ title: '长文', body: long });
  assert.equal(db.getDoc(d.id).body.length, long.length);
  db.close();
});

test('空查询不炸，也不返回全部', () => {
  const db = new SqliteLedger(':memory:');
  db.putDoc(doc());
  assert.deepEqual(db.searchDocs(''), []);
  db.close();
});

test('文档与 claim 互不干扰', () => {
  const db = new SqliteLedger(':memory:');
  db.putDoc(doc());
  assert.equal(db.active().length, 0, '文档不该出现在 claim 里');
  db.close();
});
