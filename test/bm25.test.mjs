/**
 * BM25 回归：排序、IDF、空语料、未知词。
 *
 * 跑法：node test/bm25.test.mjs
 */

import assert from 'node:assert/strict';
import { buildIndex, scoreIndex } from '../lib/bm25.js';
import { tokenize } from '../lib/tokenize.js';

const docs = [
    tokenize('薄壳模式 在宿主层 短路 llm/stream，每轮调用一次 cmd resume'),
    tokenize('FACT.md 有 100 行和 8000 字节 双上限，超限拒绝写入'),
    tokenize('右侧栏 面板 改用 注入 样式表，主题色用 color-mix 推导'),
];
const index = buildIndex(docs);

/* 命中排序 */
const shell = scoreIndex(index, tokenize('薄壳模式 短路'));
assert.ok(shell.length > 0, '应有命中');
assert.equal(shell[0].index, 0, '最相关的片段应排第一');

const fact = scoreIndex(index, tokenize('上限 拒绝写入'));
assert.equal(fact[0].index, 1, '记忆上限相关的片段应排第一');

const panel = scoreIndex(index, tokenize('右侧栏 样式表'));
assert.equal(panel[0].index, 2, '面板相关的片段应排第一');

/* 未知词 / 空查询 */
assert.deepEqual(scoreIndex(index, tokenize('量子纠缠')), [], '未知词不应命中');
assert.deepEqual(scoreIndex(index, []), [], '空查询不应命中');
assert.deepEqual(scoreIndex(buildIndex([]), tokenize('任何')), [], '空语料不应命中');

/* IDF：只在一条里出现的词，权重高于出现在全部条目里的词 */
const idfIndex = buildIndex([
    tokenize('稀有词 alpha'),
    tokenize('常见词 alpha'),
    tokenize('常见词 alpha'),
]);
const rare = scoreIndex(idfIndex, tokenize('稀有词'))[0].score;
const common = scoreIndex(idfIndex, tokenize('常见词'))[0].score;
assert.ok(rare > common, '只在一条出现的词应比到处出现的词权重高');

/* 分数降序 */
for (let position = 1; position < shell.length; position += 1) {
    assert.ok(shell[position - 1].score >= shell[position].score, '结果应按分数降序');
}

console.log('✓ bm25.test.mjs 全部通过');
