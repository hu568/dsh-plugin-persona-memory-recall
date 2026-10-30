/**
 * pre-step 注入回归：命中/去重/子代理/开关/失败降级。
 *
 * 用假 agent/session 跑真实的监听器，不需要宿主。
 *
 * 跑法：node test/inject.test.mjs
 * 想测 profile 里已安装的那份：设 PERSONA_MEMORY_RECALL_ENTRY=file:///…/lib/index.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRY = process.env.PERSONA_MEMORY_RECALL_ENTRY ?? new URL('../lib/index.js', import.meta.url).href;
const mod = await import(ENTRY);

/* ── 造日志 ─────────────────────────────────────────────────────────── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-inject-'));
const file = join(home, 'JOURNAL.jsonl');
const entries = [
    { ts: '2026-10-30T01:30:21.036Z', tags: ['dsh'], text: '薄壳模式：在宿主层短路 llm/stream，每轮只调用一次 cmd。' },
    { ts: '2026-09-01T00:00:00.000Z', tags: ['ui'], text: '右侧栏面板改用注入样式表，主题色用 color-mix 推导。' },
];
writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

const config = mod.Config({ journalPath: file });

function makeBound(overrides = {}) {
    const effective = { ...config, ...overrides };
    const store = mod.createJournalStore({
        file,
        scanEntries: effective.scanEntries,
        chunkChars: effective.chunkChars,
        maxChunksPerEntry: effective.maxChunksPerEntry,
    });
    return mod.createPreStepListener({
        config: effective,
        store,
        memoryTextsFor: () => [],
    });
}

const userMessage = (text) => ({
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
});

const makePayload = (id, turn, header = { cwd: 'C:/work' }, aborted = false) => ({
    agent: {
        id,
        session: { header, snapshotEvents: () => [], events: [] },
    },
    turn,
    step: 1,
    signal: { aborted },
});

const nextWith = (text) => async () => ({ kind: 'enter', messages: [userMessage(text)] });

/* ══ 1. 命中：追加一条快照消息，形状正确 ══ */
{
    const bound = makeBound();
    const payload = makePayload('s1', 1);
    const decision = await bound.listener(payload, nextWith('薄壳模式怎么短路 llm stream'));
    assert.equal(decision.messages.length, 2, '命中时应追加一条消息');
    const injected = decision.messages[1];
    assert.equal(typeof injected.id, 'string');
    assert.equal(injected.role, 'user');
    assert.equal(injected.source.kind, mod.SOURCE_KIND, '来源标记应唯一');
    assert.equal(injected.source.form, 'snapshot', '应标记为快照，客户端才不会当成用户原话');
    assert.deepEqual(injected.source.sections.map((section) => section.name), [mod.SECTION_NAME]);
    assert.match(injected.content[0].text, /^<recalled-journal /);
    assert.match(injected.content[0].text, /薄壳模式/);
    assert.equal(bound.states.size, 1, '应记录会话状态');

    /* 同一轮同一查询（工具循环 step 2..N）不重复注入 */
    const again = await bound.listener(payload, nextWith('薄壳模式怎么短路 llm stream'));
    assert.equal(again.messages.length, 1, '同一轮同一查询只注入一次');

    /* 同一轮换了查询（steering）→ 允许再召回一次 */
    const steered = await bound.listener(payload, nextWith('右侧栏面板的样式表怎么推导'));
    assert.equal(steered.messages.length, 2, '同一轮的新查询应重新召回');

    /* 新的一轮即使查询相同也应重新召回 */
    const nextTurn = await bound.listener(makePayload('s1', 2), nextWith('薄壳模式怎么短路 llm stream'));
    assert.equal(nextTurn.messages.length, 2, '新的一轮应重新召回');
    bound.dispose();
    assert.equal(bound.states.size, 0, 'dispose 应清空状态');
}

/* ══ 2. 不命中：一条都不发 ══ */
{
    const bound = makeBound();
    const decision = await bound.listener(makePayload('s2', 1), nextWith('今天天气怎么样'));
    assert.equal(decision.messages.length, 1, '不命中不应注入');
}

/* ══ 3. 子代理默认不注入；subagent=true 时注入 ══ */
{
    const child = { cwd: 'C:/work', origin: 'subagent' };
    const bound = makeBound();
    const skipped = await bound.listener(makePayload('child-1', 1, child), nextWith('薄壳模式短路'));
    assert.equal(skipped.messages.length, 1, '子代理默认不注入');

    const allowed = makeBound({ subagent: true });
    const injected = await allowed.listener(makePayload('child-2', 1, child), nextWith('薄壳模式短路'));
    assert.equal(injected.messages.length, 2, 'subagent=true 时子代理也注入');
}

/* ══ 4. 总开关 / abort ══ */
{
    const off = makeBound({ enabled: false });
    const decision = await off.listener(makePayload('s3', 1), nextWith('薄壳模式短路'));
    assert.equal(decision.messages.length, 1, 'enabled=false 不注入');
}
{
    const bound = makeBound();
    const decision = await bound.listener(makePayload('s4', 1, { cwd: 'C:/work' }, true), nextWith('薄壳模式短路'));
    assert.equal(decision.messages.length, 1, 'signal 已 abort 不注入');
}

/* ══ 5. reject 决策原样返回 ══ */
{
    const bound = makeBound();
    const rejected = { kind: 'reject', reason: 'blocked' };
    const decision = await bound.listener(makePayload('s5', 1), async () => rejected);
    assert.equal(decision, rejected, 'reject 应原样返回');
}

/* ══ 6. 召回内部炸掉也不能炸 turn ══ */
{
    const bound = mod.createPreStepListener({
        config,
        store: { snapshot() { throw new Error('boom'); } },
        memoryTextsFor: () => [],
        logger: { warn() { } },
    });
    const decision = await bound.listener(makePayload('s6', 1), nextWith('薄壳模式短路'));
    assert.equal(decision.messages.length, 1, '内部异常应降级为「这轮不召回」');
}

/* ══ 7. 与 FACT.md / 项目 MEMORY.md 去重 ══ */
{
    const bound = mod.createPreStepListener({
        config,
        store: mod.createJournalStore({ file, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 }),
        memoryTextsFor: () => [entries[0].text],
    });
    const decision = await bound.listener(makePayload('s7', 1), nextWith('薄壳模式短路 llm stream'));
    assert.equal(decision.messages.length, 1, '内容已在 FACT.md 里就不再召回');
}

/* ══ 8. Config 默认值可读 ══ */
{
    const defaults = mod.Config({});
    assert.equal(defaults.enabled, true);
    assert.equal(defaults.topK, 5);
    assert.equal(defaults.maxChars, 600);
    assert.equal(defaults.subagent, false);
    assert.equal(defaults.journalPath, '');
}

rmSync(home, { recursive: true, force: true });
console.log('✓ inject.test.mjs 全部通过');
