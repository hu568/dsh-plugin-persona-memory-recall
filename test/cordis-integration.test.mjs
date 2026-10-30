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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ASAR = process.env.DSH_ASAR_ROOT
    ?? 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai';
const ENTRY = process.env.PERSONA_MEMORY_RECALL_ENTRY ?? new URL('../lib/index.js', import.meta.url).href;

const { Context } = await import(`file:///${ASAR}/cordis/lib/index.js`);
const mod = await import(ENTRY);

const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-e2e-'));
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

/* ══ 4. dispose 后监听器被摘掉 ══ */
await fiber.dispose();
const afterDispose = await dispatch(3, '薄壳模式怎么短路 llm stream');
assert.equal(afterDispose.messages.length, 1, '插件卸载后不应再注入');

rmSync(home, { recursive: true, force: true });
console.log('✓ cordis-integration.test.mjs 全部通过（真实 cordis + 真实事件派发）');
