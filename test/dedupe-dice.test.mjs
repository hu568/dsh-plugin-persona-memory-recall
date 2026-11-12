/**
 * 与 FACT.md / 项目 MEMORY.md 去重（ROADMAP D5）：按行比对 + Dice 系数。
 *
 * 旧行为是「整段 240 字符 chunk 被子串包含」——记忆文件里都是单行结论，几乎永远
 * 不可能包含整个 chunk，于是模型刚在系统提示词里看过的结论又被召回注入一遍。
 *
 * 跑法：node test/dedupe-dice.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryDeduper, diceCoefficient, splitDedupeLines } from '../lib/dedupe.js';
import { createJournalStore } from '../lib/journal.js';
import { recall } from '../lib/recall.js';

/* ══ 1. 行切分：去列表符号、丢空行 ══ */
assert.deepEqual(
    splitDedupeLines('# 标题\n\n- 第一条结论\n1. 第二条结论\n   \n* 第三条'),
    ['# 标题', '第一条结论', '第二条结论', '第三条'],
    '列表符号应剥掉、空行应丢掉',
);

/* ══ 2. Dice：同文 1、无交集 0、语序无关 ══ */
const a = ['召回', '回预', '预算', '算口', '口径'];
assert.equal(diceCoefficient(a, a), 1);
assert.equal(diceCoefficient(a, ['面板', '板样', '样式']), 0);
assert.equal(diceCoefficient(a, ['预算', '算口', '口径', '召回', '回预']), 1, 'Dice 对语序不敏感');
assert.equal(diceCoefficient(a, []), 0);

/* ══ 3. 行级去重：短条目（单行结论）也能命中，即使 chunk 还有别的内容 ══ */
{
    const memory = ['# FACT.md', '', '- 定稿快照放 bak 目录，活文档在原处修改。'];
    const dedupe = createMemoryDeduper(memory);
    const chunk = '定稿快照放 bak 目录，活文档在原处修改。\n另外一段完全无关的长内容：面板样式用注入样式表推导主题色，和上面的结论没有关系。';
    const hit = dedupe(chunk);
    assert.ok(hit !== null, '单行结论应能被行级比对命中');
    assert.ok(hit.dice >= 0.7);
}

/* ══ 4. 换措辞（同一结论）也能命中；无关内容不命中 ══ */
{
    const dedupe = createMemoryDeduper(['- 召回预算的总额口径是 600 字符，前言也算在内。']);
    assert.ok(dedupe('召回预算的总额口径是 600 字符，前言同样算在内。') !== null, '同义改写应判重复');
    assert.equal(dedupe('右侧栏面板改用注入样式表，主题色用 color-mix 推导。'), null, '无关内容不应判重复');
}

/* ══ 5. 阈值可配：0 = 关掉 Dice（只剩整段原文包含兜底） ══ */
{
    const memory = ['- 召回预算的总额口径是 600 字符，前言也算在内。'];
    const paraphrase = '召回预算的总额口径就是 600 字符，前言同样计入。';
    assert.ok(createMemoryDeduper(memory, { threshold: 0.99 })(paraphrase) === null, '阈值调高后近似改写不判重复');
    assert.ok(createMemoryDeduper(memory, { threshold: 0 })(paraphrase) === null, '阈值 0 关掉 Dice');
    assert.ok(createMemoryDeduper(memory).call(null, memory[0]) !== null, '原文相同仍应判重复（行级 Dice=1）');
}

/* ══ 6. 过短的行不参与比对（minLineChars） ══ */
{
    const dedupe = createMemoryDeduper(['- 注意'], { minLineChars: 12 });
    assert.equal(dedupe('注意'), null, '短于 minLineChars 的记忆行不参与比对');
}

/* ══ 7. 接进 recall：与记忆文件重复的片段跳过并计数 ══ */
{
    const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-dedupe-'));
    const file = join(home, 'JOURNAL.jsonl');
    const text = '召回预算的总额口径是 600 字符，前言也算在内。';
    writeFileSync(file, JSON.stringify({ ts: '2026-11-09T00:00:00.000Z', tags: ['recall'], text }) + '\n', 'utf8');
    const snapshot = createJournalStore({ file, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 }).snapshot();
    const config = {
        topK: 5,
        maxTotalChars: 600,
        maxEntryChars: 240,
        minScore: 0.1,
        relativeCut: 0,
        minQueryTokens: 2,
        recencyHalfLifeDays: 0,
        recencyWeight: 0,
        dedupeDiceThreshold: 0.7,
    };
    const dup = recall({ snapshot, query: '召回预算总额口径', config, memoryTexts: ['- ' + text] });
    assert.equal(dup.text, null, '与记忆文件重复时不应注入');
    assert.ok(dup.filtered.duplicate >= 1, '应记录去重挡下的片段数');

    const off = recall({ snapshot, query: '召回预算总额口径', config: { ...config, dedupeAgainstMemory: false }, memoryTexts: ['- ' + text] });
    assert.equal(off.reason, 'ok', '关掉去重后应恢复注入');

    rmSync(home, { recursive: true, force: true });
}

console.log('✓ dedupe-dice.test.mjs 全部通过');
