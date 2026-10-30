/**
 * 真实数据冒烟：用用户真实的 `$DSH_HOME/memory/JOURNAL.jsonl`（只读）建索引并召回。
 *
 * 只验证「不抛错 + 形状正确 + 打印结果供人看」，不硬断言排序 ——
 * 真实日志会持续变化，写死期望值只会变成噪音。
 *
 * 跑法：node test/real-data.test.mjs
 * 自选查询：DSH_RECALL_QUERY="薄壳 上限 面板" node test/real-data.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createJournalStore } from '../lib/journal.js';
import { recall } from '../lib/recall.js';

const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const file = join(home, 'memory', 'JOURNAL.jsonl');

if (!existsSync(file)) {
    console.log(`✓ real-data.test.mjs 跳过：没有日志文件 ${file}`);
    process.exit(0);
}

const store = createJournalStore({ file, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 });
const started = Date.now();
const snapshot = store.snapshot();
const buildMs = Date.now() - started;

assert.ok(snapshot.total >= 1, '真实日志应至少有一条记录');
assert.equal(snapshot.file, file);
assert.ok(snapshot.chunks.length >= 1, '应切出至少一段');
console.log(`索引：${snapshot.total} 条 / ${snapshot.chunks.length} 段 / ${snapshot.bytes} 字节，构建 ${buildMs} ms`);

/* 第二次读应该是缓存命中（同一对象） */
const cachedStart = Date.now();
const again = store.snapshot();
const cachedMs = Date.now() - cachedStart;
assert.equal(again, snapshot, '文件没变应命中缓存');
console.log(`缓存命中：${cachedMs} ms`);

const query = process.env.DSH_RECALL_QUERY ?? '薄壳 上限 面板 记忆 插件';
const config = {
    topK: 5,
    maxChars: 600,
    perChunkChars: 240,
    minScore: 0.5,
    relativeCut: 0.2,
    recencyHalfLifeDays: 30,
    recencyWeight: 0.15,
    minQueryTokens: 2,
};

const result = recall({ snapshot, query, config, memoryTexts: [] });
console.log(`\n查询：${query}\n结果：${result.reason}，命中 ${result.hits.length} 段，${result.usedChars} 字符`);
for (const hit of result.hits) {
    console.log(`  [${hit.score.toFixed(2)}] ${hit.ts} ${hit.tags.join(',')} — ${hit.text.slice(0, 60).replace(/\s+/g, ' ')}`);
}
if (result.text !== null) {
    assert.match(result.text, /<recalled-journal /);
    assert.ok(result.text.includes('</recalled-journal>'));
    assert.ok(result.usedChars <= config.maxChars);
    console.log('\n--- 渲染结果（前 12 行）---');
    console.log(result.text.split('\n').slice(0, 12).join('\n'));
}

console.log('\n✓ real-data.test.mjs 全部通过（只读真实日志）');
