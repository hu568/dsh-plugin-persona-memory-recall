/**
 * 端到端集成：真实 cordis Context 挂载本插件，真实派发 `agent/pre-step`。
 *
 * 证明的不是「监听器函数能跑」（inject.test.mjs 已覆盖），而是：
 *  - `ctx.plugin()` 能激活本插件（导出 name/Config/apply 的形状正确）；
 *  - `ctx.on('agent/pre-step', …)` 注册在宿主层能被事件派发命中；
 *  - fiber dispose 后监听器真的被摘掉。
 *
 * 跑法（必须用 Harness 的 Electron node，才能 import asar 内的 cordis）：
 *   ELECTRON_RUN_AS_NODE=1 "<Harness.exe>" test/cordis-integration.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveHostModules } from './_host-paths.mjs';

const HOST = resolveHostModules();
const ENTRY = process.env.PERSONA_MEMORY_RECALL_ENTRY ?? new URL('../lib/index.js', import.meta.url).href;

// 先建临时 home 再 import：apply() 会按 DSH_HOME 读写压缩标记文件，绝不能碰真实 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-e2e-'));
process.env.DSH_HOME = home;

const { Context } = await import(pathToFileURL(join(HOST, 'cordis', 'lib', 'index.js')).href);
const mod = await import(ENTRY);
const file = join(home, 'JOURNAL.jsonl');
writeFileSync(
    file,
    `${JSON.stringify({
        ts: '2026-10-30T01:30:21.036Z',
        tags: ['dsh', 'command-code'],
        text: '薄壳模式：在宿主层短路 llm/stream，每轮只调用一次 cmd -p --resume。',
    })}\n`,
    'utf8',
);

const ctx = new Context();
const fiber = ctx.plugin(mod, { journalPath: file });
await fiber.await();
assert.equal(fiber.state, 2, '插件 fiber 应激活到 ACTIVE（state 2）');

const userMessage = (text) => ({
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
});

const agent = {
    id: 'root-1',
    session: { header: { cwd: home }, snapshotEvents: () => [], events: [] },
};

const dispatch = (turn, text) => {
    const payload = { agent, turn, step: 1, signal: { aborted: false } };
    return ctx.waterfall(
        'agent/pre-step',
        payload,
        () => Promise.resolve({ kind: 'enter', messages: [userMessage(text)] }),
    );
};

/* ══ 1. 真实派发：命中 → 追加快照消息 ══ */
const first = await dispatch(1, '薄壳模式怎么短路 llm stream');
assert.equal(first.messages.length, 2, '应追加一条召回消息');
assert.equal(first.messages[1].source.kind, mod.SOURCE_KIND);
assert.equal(first.messages[1].source.form, 'snapshot');
assert.match(first.messages[1].content[0].text, /<recalled-journal /);
assert.match(first.messages[1].content[0].text, /薄壳模式/);

/* ══ 2. 同一轮同一查询不重复 ══ */
const second = await dispatch(1, '薄壳模式怎么短路 llm stream');
assert.equal(second.messages.length, 1, '同一轮同一查询不应重复注入');

/* ══ 3. 不相关查询不注入 ══ */
const irrelevant = await dispatch(2, '今天天气怎么样');
assert.equal(irrelevant.messages.length, 1, '不命中不应注入');

/* ══ 4. 压缩后重注入：真实 session/event → 真实 pre-step，重建包 splice 到用户消息之前 ══ */
const pendingFile = join(home, 'memory', 'recall', 'pending-rehydrate.json');
{
    // 成功的压缩：error 缺省
    ctx.emit(
        'session/event',
        { id: 'root-compacted' },
        { type: 'compaction/end', data: { compactionId: 'c1', turn: 1 } },
    );
    const saved = JSON.parse(readFileSync(pendingFile, 'utf8'));
    assert.ok(saved.sessions['root-compacted'], '压缩成功应把标记落盘');

    const compactedAgent = {
        id: 'root-compacted',
        session: { id: 'root-compacted', header: { cwd: home }, snapshotEvents: () => [], events: [] },
    };
    const rehydrated = await ctx.waterfall(
        'agent/pre-step',
        { agent: compactedAgent, turn: 1, step: 1, signal: { aborted: false } },
        () => Promise.resolve({ kind: 'enter', messages: [userMessage('今天天气怎么样')] }),
    );
    assert.equal(rehydrated.messages.length, 2, '压缩后的第一个用户轮应注入重建包');
    assert.equal(rehydrated.messages[0].source.kind, mod.SOURCE_KIND);
    assert.deepEqual(rehydrated.messages[0].source.sections.map((section) => section.name), [
        mod.REHYDRATE_SECTION_NAME,
    ]);
    assert.match(rehydrated.messages[0].content[0].text, /^【会话已压缩】/, '开头应是固定句');
    assert.equal(rehydrated.messages[1].source.kind, 'user', '真实用户消息必须在重建包之后');
    const afterInject = JSON.parse(readFileSync(pendingFile, 'utf8'));
    assert.equal(afterInject.sessions['root-compacted'], undefined, '注入成功后标记应被清掉');
}

/* ══ 5. 失败的压缩（data.error 非空）不置位，下一轮不注入 ══ */
{
    ctx.emit(
        'session/event',
        { id: 'root-failed' },
        { type: 'compaction/end', data: { compactionId: 'c2', error: 'boom' } },
    );
    const failedAgent = {
        id: 'root-failed',
        session: { id: 'root-failed', header: { cwd: home }, snapshotEvents: () => [], events: [] },
    };
    const decision = await ctx.waterfall(
        'agent/pre-step',
        { agent: failedAgent, turn: 1, step: 1, signal: { aborted: false } },
        () => Promise.resolve({ kind: 'enter', messages: [userMessage('今天天气怎么样')] }),
    );
    assert.equal(decision.messages.length, 1, '压缩失败时内容没被逐出，不应重注入');
}

/* ══ 6. dispose 后监听器被摘掉 ══ */
await fiber.dispose();
const afterDispose = await dispatch(3, '薄壳模式怎么短路 llm stream');
assert.equal(afterDispose.messages.length, 1, '插件卸载后不应再注入');

rmSync(home, { recursive: true, force: true });
console.log('✓ cordis-integration.test.mjs 全部通过（真实 cordis + 真实事件派发）');
