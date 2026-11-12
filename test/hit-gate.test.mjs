/**
 * 命中门槛（ROADMAP D2）：单个常见 2-gram 不再算证据；topK 按最高分分档 5/4/3/1。
 *
 * 复现的真实症状：「天气插件」只与工程日志重叠一个「插件」，过去注入 4 条 1.76 分
 * 的无关日志。这里用同形状的小语料把「常见单命中过滤 / 罕见单命中放行 / 多命中放行」
 * 三条路径都钉住。
 *
 * 跑法：node test/hit-gate.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournalStore } from '../lib/journal.js';
import { effectiveTopK, hitGate, recall } from '../lib/recall.js';

const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-gate-'));

/* 四条工程日志都含「插件」——这就是「常见词」。 */
const engineering = [
    '插件安装与插件配置：清单改完要重启引擎，运行中的代码不变。',
    '插件市场热度看安装量和下载量，不看 GitHub 星数。',
    '插件设置页回写要先校验再落盘，写入失败保留旧值。',
    '插件日志检索按 2-gram 打分，短片段需要额外门槛。',
];
const weather = '今天天气晴朗，出门散步很舒服。';

function writeJournal(name, texts) {
    const file = join(home, name);
    const rows = texts.map((text, index) => JSON.stringify({
        ts: '2026-11-0' + (index + 1) + 'T00:00:00.000Z',
        tags: index >= engineering.length ? ['note'] : ['dsh'],
        text,
    }));
    writeFileSync(file, rows.join('\n') + '\n', 'utf8');
    return createJournalStore({ file, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 }).snapshot();
}

const engineeringOnly = writeJournal('engineering.jsonl', engineering);
const withWeather = writeJournal('with-weather.jsonl', [...engineering, weather]);

const config = {
    topK: 5,
    maxTotalChars: 2000,
    maxEntryChars: 400,
    minScore: 0.1,
    relativeCut: 0,
    minQueryTokens: 2,
    recencyHalfLifeDays: 0,
    recencyWeight: 0,
};

/* ══ 1. 单命中 + 常见词：一条工程日志都不注入（就是那个 1.76 分的症状） ══ */
{
    const result = recall({ snapshot: engineeringOnly, query: '天气插件', config });
    assert.equal(result.text, null, '只重叠一个常见词时不应注入');
    assert.equal(result.reason, 'filtered', '原因应是门槛筛掉（不是分数不够）');
    assert.ok(result.filtered.gate >= 1, '门槛应记录被挡下的片段数');
    assert.equal(result.hits.length, 0);
}

/* ══ 2. 单命中 + 罕见词：放行（天气那条确实相关） ══ */
{
    const result = recall({ snapshot: withWeather, query: '天气插件', config });
    assert.equal(result.reason, 'ok', '罕见词单命中应能注入');
    assert.equal(result.hits.length, 1, '只应注入谈到天气的那一条');
    assert.match(result.hits[0].text, /天气/);
    for (const hit of result.hits) {
        assert.ok(!engineering.includes(hit.text), '不应注入「插件」巧合命中的工程日志');
    }
}

/* ══ 3. 直接测门槛函数：常见单命中不过、罕见单命中过、多命中过、可关 ══ */
{
    const index = withWeather.index;
    const commonItem = { matched: ['插件'], docLen: 30, queryExisting: 2 };
    const common = hitGate({}, commonItem, 2, index);
    assert.equal(common.ok, false, '常见词单命中不应过门槛');
    assert.ok(common.coverage < 0.15);

    const rareItem = { matched: ['天气'], docLen: 20, queryExisting: 2 };
    assert.equal(hitGate({}, rareItem, 2, index).ok, true, '罕见词单命中应过门槛');

    const twoItem = { matched: ['插件', '引擎'], docLen: 30, queryExisting: 2 };
    assert.equal(hitGate({}, twoItem, 2, index).ok, true, '两个命中词应直接过门槛');
    assert.equal(hitGate({}, twoItem, 2, index).coverage, 1);

    // 门槛可关：两个阈值都是 0 时全部放行。
    assert.equal(hitGate({ minMatchedTokens: 0, minCoverage: 0 }, commonItem, 2, index).ok, true);
}

/* ══ 4. 多命中：真正相关的工程日志照常注入 ══ */
{
    const result = recall({ snapshot: engineeringOnly, query: '插件 引擎 重启', config });
    assert.equal(result.reason, 'ok');
    assert.ok(result.text.startsWith('<recalled-journal '));
    assert.ok(result.hits.length >= 1);
    assert.match(result.hits[0].text, /引擎/);
}

/* ══ 5. topK 分档：5 / 4 / 3 / 1，且用户 topK 仍是硬上限 ══ */
{
    const five = { minScore: 1, topK: 5 };
    assert.equal(effectiveTopK(five, 3.5), 5, '强命中给满 5 个名额');
    assert.equal(effectiveTopK(five, 2.5), 4);
    assert.equal(effectiveTopK(five, 1.5), 3);
    assert.equal(effectiveTopK(five, 1.1), 1, '弱命中只给 1 个名额');
    assert.equal(effectiveTopK({ minScore: 1, topK: 2 }, 5), 2, '用户设 2 就最多 2');
    assert.equal(effectiveTopK({ minScore: 0, topK: 5 }, 0.001), 5, 'minScore=0 时按满档');
    assert.equal(effectiveTopK({ minScore: 1, topK: 9 }, 9), 5, '分档上限是 5，不会超过');
}

/* ══ 6. 分档接进 recall：实际条数不超过 effectiveTopK ══ */
{
    const result = recall({ snapshot: engineeringOnly, query: '插件 引擎 重启', config });
    assert.equal(result.reason, 'ok');
    assert.ok(result.effectiveTopK >= 1 && result.effectiveTopK <= 5);
    assert.ok(result.hits.length <= result.effectiveTopK, '实际条数不应超过分档上限');
}

rmSync(home, { recursive: true, force: true });
console.log('✓ hit-gate.test.mjs 全部通过');
