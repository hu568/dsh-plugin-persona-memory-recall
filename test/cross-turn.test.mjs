/**
 * 跨轮去重（ROADMAP D3）：同一片段注入过就不再注入；指纹按原始片段算，截断窗口不影响身份。
 *
 * 为什么不能只靠「同轮同查询」：换措辞或隔一轮再问同一件事时，BM25 会再次命中同一段，
 * 旧行为会把它重新塞进上下文，累积到下一次压缩；模型看到同一段工程日志好几遍。
 *
 * 跑法：node test/cross-turn.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournalStore } from '../lib/journal.js';
import { recall } from '../lib/recall.js';

const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-cross-turn-'));
const file = join(home, 'JOURNAL.jsonl');
const entries = [
    { ts: '2026-11-09T00:00:00.000Z', tags: ['dsh'], text: '薄壳模式：在宿主层短路 llm/stream，每轮只调用一次 cmd，DSH 自身零推理。' },
    { ts: '2026-11-08T00:00:00.000Z', tags: ['ui'], text: '右侧栏面板改用注入样式表，主题色用 color-mix 从当前文字色推导。' },
];
writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

const store = createJournalStore({ file, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 });
const snapshot = store.snapshot();
const base = {
    topK: 5,
    maxTotalChars: 600,
    maxEntryChars: 240,
    minScore: 0.1,
    relativeCut: 0,
    minQueryTokens: 2,
    recencyHalfLifeDays: 0,
    recencyWeight: 0,
};

/* ══ 1. 第一次命中 → 拿到指纹；同一查询再跑（模拟下一轮）→ 被跨轮去重挡住 ══ */
const first = recall({ snapshot, query: '薄壳模式短路 llm stream', config: base });
assert.equal(first.reason, 'ok');
assert.equal(first.hits.length, 1);
const hash = first.hits[0].hash;
assert.equal(typeof hash, 'string');
assert.ok(hash.length >= 8, '指纹应是稳定哈希');

const second = recall({
    snapshot,
    query: '薄壳模式怎么短路 llm stream',
    config: base,
    skipChunkHashes: new Set([hash]),
});
assert.equal(second.text, null, '已注入过的片段换措辞也不应重注');
assert.ok(second.filtered.injected >= 1, '应记录被跨轮去重挡下的片段数');

/* ══ 2. 指纹按原始片段算：截断预算不同，指纹不变 ══ */
const tiny = recall({ snapshot, query: '薄壳模式短路 llm stream', config: { ...base, maxEntryChars: 60, maxTotalChars: 400 } });
assert.equal(tiny.reason, 'ok');
assert.ok(tiny.hits[0].text.length < first.hits[0].text.length, '窄预算下正文应更短');
assert.equal(tiny.hits[0].hash, hash, '同一片段在不同截断窗口下指纹必须相同');

/* ══ 3. 数组形式同样支持（宿主状态里是 Set，测试/诊断可直接给数组） ══ */
const arraySkip = recall({ snapshot, query: '薄壳模式短路 llm stream', config: base, skipChunkHashes: [hash] });
assert.equal(arraySkip.text, null);

/* ══ 4. 没注入过的片段不受影响 ══ */
const other = recall({ snapshot, query: '右侧栏面板 样式表 主题色', config: base, skipChunkHashes: [hash] });
assert.equal(other.reason, 'ok', '别的片段仍应可召回');
assert.ok(other.hits.some((hit) => hit.hash !== hash));

rmSync(home, { recursive: true, force: true });
console.log('✓ cross-turn.test.mjs 全部通过');
