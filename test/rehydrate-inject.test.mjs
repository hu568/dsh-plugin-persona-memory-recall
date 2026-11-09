/**
 * 压缩后重注入回归：splice 位置、只在该会话、要有真实用户消息、与 BM25 二选一、注入后清标记。
 *
 * 跑法：node test/rehydrate-inject.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 先用临时 DSH_HOME，再由 index.js 的 apply()/默认路径继承；测试不碰真实 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-rehydrate-'));
process.env.DSH_HOME = home;

const mod = await import('../lib/index.js');
const { createCompactionWatch } = await import('../lib/compaction-watch.js');
const { REHYDRATE_HEADER } = await import('../lib/rehydrate.js');

const journal = join(home, 'JOURNAL.jsonl');
const entries = [
    { ts: '2026-10-30T01:30:21.036Z', tags: ['dsh'], text: '薄壳模式：在宿主层短路 llm/stream，每轮只调用一次 cmd。' },
    { ts: '2026-10-29T01:30:21.036Z', tags: ['ui'], text: '右侧栏面板改用注入样式表，主题色用 color-mix 推导。' },
];
writeFileSync(journal, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

const config = mod.Config({ journalPath: journal, debug: true });

function makeBound(overrides = {}, options = {}) {
    const effective = { ...config, ...overrides };
    const store = mod.createJournalStore({
        file: journal,
        scanEntries: effective.scanEntries,
        chunkChars: effective.chunkChars,
        maxChunksPerEntry: effective.maxChunksPerEntry,
    });
    const watch = options.watch ?? createCompactionWatch({ file: join(home, 'pending.json') });
    const logs = [];
    const bound = mod.createPreStepListener({
        config: effective,
        store,
        memoryTextsFor: () => [],
        logger: { info: (message) => logs.push(message), warn: (message) => logs.push(`warn:${message}`) },
        // 与 apply() 的接线同口径：rehydrate=false 时根本不传 watch。
        watch: effective.rehydrate ? watch : undefined,
    });
    return { bound, watch, logs };
}

const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
const contextMessage = (text) => ({
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'runtime-context' },
});

const makePayload = (id, turn, header = { cwd: '/root/work' }) => ({
    agent: {
        id,
        session: {
            id,
            header,
            snapshotEvents: () => [],
            events: [],
        },
    },
    turn,
    step: 1,
    signal: { aborted: false },
});

const nextWith = (...texts) => async () => ({ kind: 'enter', messages: texts.map((text) => userMessage(text)) });

/* ══ 1. splice：重建包插在用户消息**之前**，且形状是快照消息 ══ */
{
    const { bound, watch, logs } = makeBound();
    watch.mark('s1');
    const decision = await bound.listener(makePayload('s1', 1), nextWith('今天天气怎么样'));

    assert.equal(decision.messages.length, 2, '应注入一条重建包');
    const injected = decision.messages[0];
    assert.equal(injected.role, 'user');
    assert.equal(injected.source.kind, mod.SOURCE_KIND, '来源标记应唯一');
    assert.equal(injected.source.form, 'snapshot');
    assert.deepEqual(injected.source.sections.map((section) => section.name), [mod.REHYDRATE_SECTION_NAME]);
    assert.ok(injected.content[0].text.startsWith(REHYDRATE_HEADER), '开头必须是【会话已压缩】固定句');
    assert.ok(injected.content[0].text.includes('薄壳模式'), '应按当前库重建本会话最近的日志');
    assert.ok(injected.content[0].text.length <= config.maxRehydrateChars, '重建包不许超总预算');
    assert.equal(decision.messages[1].source.kind, 'user', '真实用户消息应排在重建包之后');
    assert.ok(logs.some((line) => line.includes('path=rehydrate')), 'debug 应写明走了哪条路');

    // 注入成功即清标记（内存 + 落盘）
    assert.equal(watch.isPending('s1'), false, '注入成功后应清标记');
}

/* ══ 2. 多条用户消息：只 splice 到「最后一条真人消息」之前 ══ */
{
    const { bound, watch } = makeBound();
    watch.mark('s2');
    const decision = await bound.listener(makePayload('s2', 1), nextWith('第一句输入', '今天天气怎么样'));
    assert.equal(decision.messages.length, 3);
    assert.equal(decision.messages[0].source.kind, 'user', '第一条用户消息位置不动');
    assert.equal(decision.messages[1].source.kind, mod.SOURCE_KIND, '重建包应紧贴最后一条用户消息之前');
    assert.equal(decision.messages[2].content[0].text, '今天天气怎么样');
}

/* ══ 3. 只在该会话：别的会话没有标记就不注入 ══ */
{
    const { bound, watch } = makeBound();
    watch.mark('s3');
    const decision = await bound.listener(makePayload('s4', 1), nextWith('今天天气怎么样'));
    assert.equal(decision.messages.length, 1, '未标记的会话不应收到重建包');
    assert.equal(watch.isPending('s3'), true, '别的会话的标记不应被清');
}

/* ══ 4. 本轮没有真实用户消息（插件轮/续跑）：不注入、保留标记 ══ */
{
    const { bound, watch } = makeBound();
    watch.mark('s5');
    const payload = makePayload('s5', 1);
    payload.agent.session.events = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { message: userMessage('今天天气怎么样') } },
    ];
    payload.agent.session.snapshotEvents = () => payload.agent.session.events;

    const decision = await bound.listener(payload, async () => ({ kind: 'enter', messages: [contextMessage('运行时上下文')] }));
    assert.equal(decision.messages.length, 1, '没有真实用户消息时不应往消息流里塞重建包');
    assert.equal(watch.isPending('s5'), true, '标记应保留到真正有用户输入的轮次');
}

/* ══ 5. 子代理默认不注入重建包（标记保留给主会话/后续轮） ══ */
{
    const { bound, watch } = makeBound();
    watch.mark('child-1');
    const decision = await bound.listener(
        makePayload('child-1', 1, { cwd: '/root/work', origin: 'subagent' }),
        nextWith('今天天气怎么样'),
    );
    assert.equal(decision.messages.length, 1, '子代理默认不注入');
    assert.equal(watch.isPending('child-1'), true, '子代理这轮没有注入，标记不应清');
}

/* ══ 6. 与 BM25 二选一：本轮召回已命中就不重复注入重建包 ══ */
{
    const { bound, watch, logs } = makeBound();
    watch.mark('s6');
    const decision = await bound.listener(makePayload('s6', 1), nextWith('薄壳模式怎么短路 llm stream'));
    assert.equal(decision.messages.length, 2, '本轮只允许一条注入消息');
    assert.match(decision.messages[1].content[0].text, /^<recalled-journal /, '命中的轮次走 BM25，不注入重建包');
    assert.equal(decision.messages[0].source.kind, 'user', 'BM25 仍按原纪律追加在用户消息之后');
    assert.ok(logs.some((line) => line.includes('path=bm25')), 'debug 应写明选了 BM25 这条路');
    assert.equal(watch.isPending('s6'), true, '重建包没注入，标记应留到没有命中的轮次');
}

/* ══ 7. 重建包为空（日志空）：不注入，但要清标记，避免每轮空转 ══ */
{
    const emptyJournal = join(home, 'EMPTY.jsonl');
    writeFileSync(emptyJournal, '', 'utf8');
    const store = mod.createJournalStore({ file: emptyJournal, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 });
    const watch = createCompactionWatch({ file: join(home, 'pending-empty.json') });
    watch.mark('s7');
    const logs = [];
    const bound = mod.createPreStepListener({
        config,
        store,
        memoryTextsFor: () => [],
        logger: { info: (message) => logs.push(message), warn() {} },
        watch,
    });
    const decision = await bound.listener(makePayload('s7', 1), nextWith('今天天气怎么样'));
    assert.equal(decision.messages.length, 1);
    assert.equal(watch.isPending('s7'), false, '空包也应清标记');
    assert.ok(logs.some((line) => line.includes('空包')), 'debug 应说明是空包');
}

/* ══ 8. rehydrate=false：完全不注入，标记不动 ══ */
{
    const { bound, watch } = makeBound({ rehydrate: false });
    watch.mark('s8');
    const decision = await bound.listener(makePayload('s8', 1), nextWith('今天天气怎么样'));
    assert.equal(decision.messages.length, 1, '关掉重建后不应注入');
    assert.equal(watch.isPending('s8'), true, '关掉重建时标记保持原样');
}

/* ══ 9. 重建包内部炸掉也不能炸 turn（watch 每步抛错） ══ */
{
    const brokenWatch = {
        isPending() { throw new Error('watch boom'); },
        marker() { return undefined; },
        clear() {},
    };
    const { bound } = makeBound({}, { watch: brokenWatch });
    const decision = await bound.listener(makePayload('s9', 1), nextWith('今天天气怎么样'));
    assert.equal(decision.messages.length, 1, '重建内部异常应降级为「这轮不注入」');
}

rmSync(home, { recursive: true, force: true });
console.log('✓ rehydrate-inject.test.mjs 全部通过');
