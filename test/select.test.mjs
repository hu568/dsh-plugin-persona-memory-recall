/**
 * 召回选择回归：阈值、预算、去重（同文 + 与既有记忆）、空输入。
 *
 * 跑法：node test/select.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournalStore } from '../lib/journal.js';
import { recall } from '../lib/recall.js';

const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-select-'));
const file = join(home, 'JOURNAL.jsonl');

const entries = [
    {
        ts: '2026-10-30T01:30:21.036Z',
        tags: ['dsh', 'command-code'],
        text: '薄壳模式：在宿主层短路 llm/stream，每轮只调用一次 cmd -p --resume，DSH 自身零推理。',
    },
    {
        ts: '2026-09-01T00:00:00.000Z',
        tags: ['ui'],
        text: '右侧栏面板改用注入样式表，主题色用 color-mix 从当前文字色推导。',
    },
    {
        ts: '2026-08-01T00:00:00.000Z',
        tags: ['memory'],
        text: 'FACT.md 有 100 行和 8000 字节双上限，超限直接拒绝写入，不做静默截断。',
    },
];
writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

const store = createJournalStore({ file, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 });
const config = {
    topK: 5,
    maxChars: 600,
    perChunkChars: 240,
    minScore: 0.5,
    relativeCut: 0.35,
    recencyHalfLifeDays: 0,
    recencyWeight: 0,
    minQueryTokens: 2,
};

/* 1. 命中正确条目 */
const shell = recall({ snapshot: store.snapshot(), query: '薄壳模式怎么短路 llm stream', config });
assert.equal(shell.reason, 'ok', '应命中');
assert.ok(shell.hits.length >= 1, '至少命中一段');
assert.match(shell.text, /<recalled-journal /, '应渲染召回标签');
assert.match(shell.text, /薄壳模式/, '应包含相关正文');
assert.ok(!shell.text.includes('右侧栏'), '不应混入无关条目');

/* 2. 不相关查询 → 不注入 */
const unrelated = recall({ snapshot: store.snapshot(), query: '今天天气怎么样', config });
assert.equal(unrelated.text, null, '不相关查询不应注入');
assert.equal(unrelated.reason, 'no-hit', '原因应是 no-hit');

/* 3. 查询太短 */
const short = recall({ snapshot: store.snapshot(), query: '好', config: { ...config, minQueryTokens: 2 } });
assert.equal(short.text, null, '过短查询不应注入');
assert.equal(short.reason, 'short-query');

/* 4. 预算：命中行的字符数不超过 maxChars */
const tight = recall({
    snapshot: store.snapshot(),
    query: '上限 拒绝写入 fact',
    config: { ...config, maxChars: 80 },
});
assert.equal(tight.reason, 'ok');
assert.ok(tight.usedChars <= 80, `预算应生效（用了 ${tight.usedChars}）`);

/* 5. 与既有记忆去重：条目正文已经在 FACT.md 里 → 不再召回 */
const already = recall({
    snapshot: store.snapshot(),
    query: '上限 拒绝写入 fact',
    config,
    memoryTexts: [entries[2].text],
});
assert.equal(already.text, null, '与 FACT.md 重复时不应召回');

/* 6. topK 上限 */
const all = recall({
    snapshot: store.snapshot(),
    query: '上限 拒绝写入 薄壳 短路 面板 样式表',
    config: { ...config, topK: 2, relativeCut: 0 },
});
assert.ok(all.hits.length <= 2, 'topK 应生效');

/* 7. 空日志 */
const emptyFile = join(home, 'EMPTY.jsonl');
writeFileSync(emptyFile, '', 'utf8');
const emptyStore = createJournalStore({ file: emptyFile, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 });
const empty = recall({ snapshot: emptyStore.snapshot(), query: '任意查询', config });
assert.equal(empty.text, null);
assert.equal(empty.reason, 'empty-journal');

/* 8. 文件不存在 */
const missingStore = createJournalStore({
    file: join(home, 'MISSING.jsonl'),
    scanEntries: 500,
    chunkChars: 300,
    maxChunksPerEntry: 12,
});
const missing = recall({ snapshot: missingStore.snapshot(), query: '任意查询', config });
assert.equal(missing.reason, 'empty-journal');

/* 9. 分数门槛：极高 minScore 时宁可不注入 */
const strict = recall({
    snapshot: store.snapshot(),
    query: '薄壳模式短路',
    config: { ...config, minScore: 1000 },
});
assert.equal(strict.text, null);
assert.equal(strict.reason, 'below-min-score');

rmSync(home, { recursive: true, force: true });
console.log('✓ select.test.mjs 全部通过');
