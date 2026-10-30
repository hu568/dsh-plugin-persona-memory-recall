/**
 * 查询提取回归：只认 source.kind === 'user'，回溯到 turn/start 为止。
 *
 * 跑法：node test/query.test.mjs
 */

import assert from 'node:assert/strict';
import { isSubagent, turnUserText } from '../lib/index.js';

const message = (text, kind = 'user') => ({
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
});

const session = {
    header: { cwd: 'C:/work' },
    snapshotEvents: () => [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { message: message('第一轮的问题') } },
        { type: 'assistant/message', data: {} },
        { type: 'user/message', data: { message: message('运行时上下文', 'runtime-context') } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        { type: 'turn/start', data: { turn: 2 } },
        { type: 'user/message', data: { message: message('第二轮前面的输入') } },
    ],
};

/* 1. 本步提出了一条用户消息：只取这一条（历史属于同一 turn，但不是本步输入） */
assert.equal(
    turnUserText(session, 2, [message('第二轮的新输入')]),
    '第二轮前面的输入\n第二轮的新输入',
    '应包含本 turn 已有的用户消息 + 本步提出的用户消息',
);

/* 2. 工具循环（step 2）：proposed 为空，仍能取回本 turn 的用户消息 */
assert.equal(turnUserText(session, 2, []), '第二轮前面的输入', 'step>1 应回溯本 turn 的用户消息');

/* 3. 回溯到 turn/start 就停：不会把上一轮算进来 */
assert.equal(turnUserText(session, 2, undefined), '第二轮前面的输入');

/* 4. runtime-context / 其它 source 不算查询 */
const onlyContext = {
    snapshotEvents: () => [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { message: message('系统注入的快照', 'runtime-context') } },
        { type: 'user/message', data: { message: message('定时提醒', 'schedule') } },
    ],
};
assert.equal(turnUserText(onlyContext, 1, []), '', '非 user 来源的消息不应当成查询');

/* 5. 超长查询只取末尾 maxChars（用户最后说的话才是意图） */
const long = '甲'.repeat(100);
assert.equal(turnUserText(onlyContext, 1, [message(`前缀${long}`)], 20).length, 20, '应截取末尾 maxChars');
assert.ok(turnUserText(onlyContext, 1, [message(`前缀${long}`)], 20).endsWith('甲'), '应保留末尾内容');

/* 6. 没有 session.events 也不炸 */
assert.equal(turnUserText({}, 1, [message('只有本步输入')]), '只有本步输入');

/* 7. 子代理判定 */
assert.equal(isSubagent({ header: { origin: 'subagent' } }), true);
assert.equal(isSubagent({ header: { parentSession: 'root' } }), true);
assert.equal(isSubagent({ header: { delegationDepth: 1 } }), true);
assert.equal(isSubagent({ header: { cwd: 'C:/work' } }), false);
assert.equal(isSubagent({}), false);

console.log('✓ query.test.mjs 全部通过');
