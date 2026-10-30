/**
 * 切段回归：句末标点合并、超长句硬切、条数上限。
 *
 * 跑法：node test/chunk.test.mjs
 */

import assert from 'node:assert/strict';
import { chunkText } from '../lib/chunk.js';

/* 按句末标点合并到预算内 */
assert.deepEqual(
    chunkText('第一句。第二句。第三句。', { maxChars: 10, minChars: 1 }),
    ['第一句。第二句。', '第三句。'],
    '应在预算内合并整句',
);

/* 换行也是分隔符 */
assert.deepEqual(chunkText('甲\n乙\n丙', { maxChars: 100 }), ['甲\n乙\n丙'], '换行分隔的短句应合并成一段');

/* 单句超长：硬切 */
const long = 'a'.repeat(25);
const sliced = chunkText(long, { maxChars: 10, minChars: 1 });
assert.deepEqual(sliced, ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)], '超长句应硬切');

/* 条数上限 */
const many = chunkText(Array.from({ length: 20 }, (_, index) => `第${index}段内容。`).join(''), {
    maxChars: 30,
    maxChunks: 3,
});
assert.equal(many.length, 3, 'maxChunks 应生效');

/* 空输入 */
assert.deepEqual(chunkText(''), [], '空串返回空数组');
assert.deepEqual(chunkText('   \n  '), [], '纯空白返回空数组');

/* 全是很短的片段时至少保留一段，避免整条消失 */
assert.ok(chunkText('好。好。', { minChars: 8 }).length > 0, '过短片段不应把整条日志清空');

/* CRLF 归一化 */
assert.deepEqual(chunkText('甲\r\n乙', { maxChars: 100 }), ['甲\n乙'], 'CRLF 应归一化为 LF');

console.log('✓ chunk.test.mjs 全部通过');
