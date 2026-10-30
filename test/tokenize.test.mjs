/**
 * 分词回归：CJK 2-gram、拉丁整词、NFKC、停用词/助词过滤。
 *
 * 跑法：node test/tokenize.test.mjs
 */

import assert from 'node:assert/strict';
import { tokenize } from '../lib/tokenize.js';

/* CJK：整段切成 2-gram */
assert.deepEqual(tokenize('记忆插件'), ['记忆', '忆插', '插件'], '中文应按 2-gram 切');

/* 拉丁/数字：整词保留，大小写与全角归一 */
assert.deepEqual(tokenize('BM25 检索'), ['bm25', '检索'], '拉丁词应整词 + 小写');
assert.deepEqual(tokenize('ＡＢＣ１２３'), ['abc123'], 'NFKC 应把全角转半角');
assert.deepEqual(tokenize('llm/stream 短路'), ['llm', 'stream', '短路'], '斜杠应分词');
assert.deepEqual(tokenize('FACT.md'), ['fact', 'md'], '点号应按分隔符处理');
assert.deepEqual(tokenize('color-mix'), ['color', 'mix'], '连字符应按分隔符处理');

/* 单字 CJK */
assert.deepEqual(tokenize('狗'), ['狗'], '单个汉字保留');

/* 停用词与助词 */
assert.deepEqual(tokenize('这个'), [], '「这个」是停用词');
assert.deepEqual(tokenize('我们的'), [], '助词组合应被丢掉');
assert.deepEqual(tokenize('更新的记忆'), ['更新', '记忆'], '只丢含助词的 2-gram，实义词保留');

/* 纯标点/空白 */
assert.deepEqual(tokenize('  ，。；!!! \n\t '), [], '标点与空白不产生 token');

/* 空输入 */
assert.deepEqual(tokenize(''), [], '空串返回空数组');
assert.deepEqual(tokenize(undefined), [], 'undefined 返回空数组');

console.log('✓ tokenize.test.mjs 全部通过');
