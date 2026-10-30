/**
 * 日志缓存回归：stat 缓存、增量重建、坏行容错、缺文件。
 *
 * 跑法：node test/journal-cache.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournalStore } from '../lib/journal.js';

const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-cache-'));
const file = join(home, 'JOURNAL.jsonl');
const options = { file, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 };

/* 缺文件：空快照，不抛错 */
const missing = createJournalStore(options);
const missingSnapshot = missing.snapshot();
assert.equal(missingSnapshot.total, 0);
assert.equal(missingSnapshot.chunks.length, 0);
assert.deepEqual(missingSnapshot.entries, []);

/* 两条合法记录 */
const line = (ts, text) => `${JSON.stringify({ ts, tags: ['t'], text })}\n`;
writeFileSync(file, line('2026-10-01T00:00:00.000Z', '第一条：薄壳模式在宿主层短路 llm/stream。') +
    line('2026-10-02T00:00:00.000Z', '第二条：FACT.md 有 100 行和 8000 字节双上限。'), 'utf8');

const store = createJournalStore(options);
const first = store.snapshot();
assert.equal(first.total, 2, '应读到 2 条');
assert.equal(first.entries.length, 2);
assert.ok(first.chunks.length >= 2, '每条至少切出一段');
assert.ok(first.index.N >= 2, '倒排应覆盖全部片段');
assert.equal(store.snapshot(), first, '文件没变应返回同一个快照对象');

/* 追加一条 + 一条坏行：总数增长，坏行被跳过 */
writeFileSync(file, line('2026-10-01T00:00:00.000Z', '第一条：薄壳模式在宿主层短路 llm/stream。') +
    line('2026-10-02T00:00:00.000Z', '第二条：FACT.md 有 100 行和 8000 字节双上限。') +
    '{ this is not json }\n' +
    line('2026-10-03T00:00:00.000Z', '第三条：右侧栏面板改用注入样式表。'), 'utf8');

const second = store.snapshot();
assert.notEqual(second, first, '文件变化后应重建');
assert.equal(second.total, 4, '总数包含坏行');
assert.equal(second.entries.length, 3, '坏行应被跳过');
assert.ok(second.chunks.length > first.chunks.length, '新条目应进入索引');

/* scanEntries：只索引尾部 */
const tailStore = createJournalStore({ ...options, scanEntries: 1 });
const tail = tailStore.snapshot();
assert.equal(tail.total, 4, '总数仍是全量');
assert.equal(tail.entries.length, 1, '只索引尾部 1 条');
assert.match(tail.entries[0].text, /右侧栏/, '尾部应是最后一条');

/* 空 text 的记录不进入索引 */
writeFileSync(file, `${JSON.stringify({ ts: '2026-10-04T00:00:00.000Z', tags: [], text: '   ' })}\n`, 'utf8');
const blank = store.snapshot();
assert.equal(blank.total, 1);
assert.equal(blank.entries.length, 0, '空正文不进入索引');

rmSync(home, { recursive: true, force: true });
console.log('✓ journal-cache.test.mjs 全部通过');
