/**
 * RAG 集成回归（recall 0.6.0）：语义通道从选择器到宿主接线的端到端行为。
 *
 * 全部离线：向量与查询向量由测试伪造，fetch 用假实现，不需要 API key、不联网。
 * 覆盖契约§六 B 必过项：
 *  1. 同义改写命中（BM25=0 时语义仍能召回并注入）；
 *  2. 相似度门槛 + 相对切能过滤低分候选；
 *  3. 无 key / 查询超时 / 后台补齐失败 → 与纯 BM25 完全一致且不抛；
 *  4. 预算、跨轮去重、工作区隔离、记忆去重、同一 ts 在语义通道下仍生效；
 *  5. apiKey 优先级 config > recall-rag.json > env，单独落盘 chmod 600、不进 recall.json。
 *
 * 跑法：node test/rag-integration.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-rag-'));
process.env.DSH_HOME = home;
delete process.env.SILICONFLOW_API_KEY;
mkdirSync(join(home, 'memory'), { recursive: true });

const mod = await import(new URL('../lib/index.js', import.meta.url).href);
const recallMod = await import(new URL('../lib/recall.js', import.meta.url).href);
const settings = await import(new URL('../lib/settings.js', import.meta.url).href);

const NOW = Date.parse('2026-11-12T12:00:00Z');
const DIM = 1024;
const POS_A = '/root/workspace/DSH插件装配站';
const POS_B = '/root/workspace/other-project';

function writeJournal(name, records) {
    const file = join(home, name + '.jsonl');
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    return file;
}

function snapshotOf(file) {
    return mod.createJournalStore({ file, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 }).snapshot();
}

/** 单向量：与 [1,0,0,...] 的 cosine 恰好等于 cos（自身是单位向量）。 */
function vectorAt(cos) {
    const vector = new Float32Array(DIM);
    vector[0] = cos;
    vector[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
    return vector;
}

function queryVector() {
    const vector = new Float32Array(DIM);
    vector[0] = 1;
    return vector;
}

/** 按片段正文里的关键词伪造相似度；没有匹配的片段就是「没缓存向量」。 */
function fabricateVectors(snapshot, table) {
    const vectors = new Map();
    for (const chunk of snapshot.chunks) {
        for (const [needle, cos] of table) {
            if (chunk.text.includes(needle)) vectors.set(chunk.hash, vectorAt(cos));
        }
    }
    return vectors;
}

function chunkOf(snapshot, needle) {
    const found = snapshot.chunks.find((chunk) => chunk.text.includes(needle));
    assert.ok(found, '快照里应存在包含「' + needle + '」的片段');
    return found;
}

const userMessage = (text) => ({
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
});

const nextWith = (text) => async () => ({ kind: 'enter', messages: [userMessage(text)] });

function makePayload(id, turn) {
    return {
        agent: {
            id,
            session: { header: { cwd: POS_A }, snapshotEvents: () => [], events: [] },
        },
        turn,
        step: 1,
        signal: { aborted: false },
    };
}

function makeBound(config, semanticIndex, file) {
    return mod.createPreStepListener({
        config,
        store: mod.createJournalStore({ file, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 }),
        semanticIndex,
        memoryTextsFor: () => [],
        logger: { info() {}, warn() {} },
    });
}

const textOfDecision = (decision) => decision.messages.map((message) => message.content[0].text);

/* ══════════════════════════════════════════════════════════════════════
 * 1. 同义改写命中：查询说「检索」，正文只有「召回」，BM25=0 时语义仍召回
 * ══════════════════════════════════════════════════════════════════════ */
const semanticEntries = [
    { ts: '2026-10-30T01:30:21.036Z', tags: ['recall'], text: '召回命中门槛：罕见词覆盖率判定。', cwd: POS_A },
    { ts: '2026-10-29T01:30:21.036Z', tags: ['workspace'], text: '工作区隔离按 cwd 最长前缀判定。', cwd: POS_B },
    { ts: '2026-10-28T01:30:21.036Z', tags: ['budget'], text: '预算三分法：前言与标签也算进总额。', cwd: POS_A },
    { ts: '2026-10-27T01:30:21.036Z', tags: ['dedupe'], text: '跨轮去重按片段正文指纹，压缩后清空。', cwd: POS_A },
];
const semanticFile = writeJournal('semantic', semanticEntries);
const semanticSnapshot = snapshotOf(semanticFile);
const semanticConfig = mod.Config({ journalPath: semanticFile });
const SYNONYM_QUERY = '同义改写检索';
const vectors = fabricateVectors(semanticSnapshot, [
    ['召回命中门槛', 0.9],
    ['工作区隔离', 0.65],
    ['预算三分法', 0.3],
]);
const h1 = chunkOf(semanticSnapshot, '召回命中门槛');
const h2 = chunkOf(semanticSnapshot, '工作区隔离');

{
    const pure = recallMod.recall({ snapshot: semanticSnapshot, query: SYNONYM_QUERY, config: semanticConfig, now: NOW });
    assert.equal(pure.text, null, '纯 BM25 应一条都召不回（同义改写）');
    assert.equal(pure.reason, 'no-hit');

    const rag = recallMod.recall({
        snapshot: semanticSnapshot,
        query: SYNONYM_QUERY,
        config: semanticConfig,
        now: NOW,
        semantic: { vectors, queryVec: queryVector() },
    });
    assert.ok(rag.text !== null, '语义通道应召回同义改写片段');
    assert.match(rag.text, /召回命中门槛/);
    assert.equal(rag.reason, 'ok');
    assert.equal(rag.semantic.used, true);
    assert.equal(rag.semantic.candidates, 2, '0.9 / 0.65 过门槛，0.3 被 minSimilarity 挡掉');
    assert.ok(Math.abs(rag.semantic.topSimilarity - 0.9) < 1e-5);
    assert.equal(rag.semantic.gated, 0, '两条候选都装进了预算');
    assert.equal(rag.hits.length, 2, '融合通道应注入两条语义命中');
    assert.deepEqual(rag.hits.map((hit) => hit.hash), [h1.hash, h2.hash], '按相似度排名注入');
    for (const hit of rag.hits) {
        assert.equal(hit.bm25Score, 0, '同义改写命中没有 BM25 分');
        assert.ok(hit.similarity > 0.5, '命中应带语义相似度');
    }
    assert.ok(Math.abs(rag.hits[0].similarity - 0.9) < 1e-5);
    assert.ok(Math.abs(rag.hits[1].similarity - 0.65) < 1e-5);
}

/* ══════════════════════════════════════════════════════════════════════
 * 2. 相似度门槛 + 相对切：低分候选不能进 hits
 * ══════════════════════════════════════════════════════════════════════ */
{
    const optionsFor = (semantic) => ({
        snapshot: semanticSnapshot,
        query: SYNONYM_QUERY,
        config: semanticConfig,
        now: NOW,
        semantic: { vectors, queryVec: queryVector(), ...semantic },
    });

    const strict = recallMod.recall(optionsFor({ minSimilarity: 0.7 }));
    assert.equal(strict.semantic.candidates, 1, 'minSimilarity=0.7 应只留 0.9');
    assert.equal(strict.hits.length, 1);
    assert.equal(strict.hits[0].hash, h1.hash);

    const cut = recallMod.recall(optionsFor({ relativeCut: 0.8 }));
    assert.equal(cut.semantic.candidates, 1, '相对切 0.8 × 0.9 = 0.72 应挡掉 0.65');
    assert.equal(cut.hits.length, 1);

    const cutTight = recallMod.recall(optionsFor({ relativeCut: 1 }));
    assert.equal(cutTight.semantic.candidates, 1, '相对切 1.0 只留最高分');

    const relaxed = recallMod.recall(optionsFor({ minSimilarity: 0.6, relativeCut: 0.7 }));
    assert.equal(relaxed.semantic.candidates, 2, '0.6 门槛 + 0.7 相对切应放行 0.65');

    const impossible = recallMod.recall(optionsFor({ minSimilarity: 0.95 }));
    assert.equal(impossible.text, null, '全部门槛外的候选不应注入');
    assert.equal(impossible.reason, 'no-hit');
    assert.equal(impossible.semantic.candidates, 0);
}

/* 3 节与 2b/2c 共用的 BM25 对照组数据。 */
const bm25File = writeJournal('bm25', [
    { ts: '2026-10-30T01:30:21.036Z', tags: ['dsh'], text: '薄壳模式：在宿主层短路 llm/stream，每轮只调用一次 cmd。' },
    { ts: '2026-10-29T01:30:21.036Z', tags: ['ui'], text: '右侧栏面板改用注入样式表，主题色用 color-mix 推导。' },
]);
const bm25Config = mod.Config({ journalPath: bm25File });
const BM25_QUERY = '薄壳模式 怎么短路 llm/stream';

/* ══════════════════════════════════════════════════════════════════════
 * 2b. 语义候选为 0（全部 chunk 给无关向量、query 也无关）→ 与纯 BM25 一致
 *     Lead 验收：开语义后 BM25 的 minScore/relativeCut 闸门不能静默失效。
 * ══════════════════════════════════════════════════════════════════════ */
{
    const bm25Snapshot = snapshotOf(bm25File);
    // 正交向量：与 query 的 [1,0,...] cosine 恒为 0 → 过不了 minSimilarity，候选数应为 0。
    const unrelated = new Map();
    for (const chunk of bm25Snapshot.chunks) {
        const vector = new Float32Array(DIM);
        vector[1] = 1;
        unrelated.set(chunk.hash, vector);
    }

    const base = {
        snapshot: bm25Snapshot,
        query: BM25_QUERY,
        config: bm25Config,
        now: NOW,
    };
    const pure = recallMod.recall(base);
    const rag = recallMod.recall({
        ...base,
        semantic: { vectors: unrelated, queryVec: queryVector() },
    });
    assert.ok(pure.hits.length > 0, '对照组：纯 BM25 应有命中');
    assert.equal(rag.semantic.candidates, 0, '无关向量不应产生语义候选');
    assert.equal(rag.reason, pure.reason, 'reason 必须与纯 BM25 一致');
    assert.equal(rag.topScore, pure.topScore, 'topScore 必须与纯 BM25 一致');
    assert.equal(rag.effectiveTopK, pure.effectiveTopK, 'effectiveTopK 必须与纯 BM25 一致');
    const shape = (hit) => ({ ts: hit.ts, tags: hit.tags, text: hit.text, hash: hit.hash });
    assert.deepEqual(
        rag.hits.map(shape),
        pure.hits.map(shape),
        '候选为 0 时命中集合必须与纯 BM25 逐条一致（score 是融合分，量纲不同，单独比）',
    );
    assert.deepEqual(rag.filtered, pure.filtered, '过滤计数也应对齐');

    // BM25 最高分都过不了 minScore 时：below-min-score 的诊断口径不能因为开语义而漂移。
    const strictConfig = { ...bm25Config, minScore: 100 };
    const pureStrict = recallMod.recall({ ...base, config: strictConfig });
    const ragStrict = recallMod.recall({
        ...base,
        config: strictConfig,
        semantic: { vectors: unrelated, queryVec: queryVector() },
    });
    assert.equal(pureStrict.reason, 'below-min-score');
    assert.equal(ragStrict.reason, 'below-min-score', '开语义后 below-min-score 应保持');
    assert.equal(ragStrict.topScore, pureStrict.topScore);
    assert.equal(ragStrict.effectiveTopK, pureStrict.effectiveTopK);
    assert.equal(ragStrict.hits.length, 0);
}

/* ══════════════════════════════════════════════════════════════════════
 * 2c. BM25 弱于 floor 但语义强命中 → 仍可注入（语义命中不受 BM25 floor 约束）
 * ══════════════════════════════════════════════════════════════════════ */
{
    const filler = '这一条是无关的工程流水账，记录了一些和当前问题关系不大的细节内容，包括界面调整和构建脚本的杂项。';
    const weakFile = writeJournal('weak-floor', [
        { ts: '2026-10-30T01:30:21.036Z', tags: ['dsh'], text: '薄壳模式：在宿主层短路 llm/stream，每轮只调用一次 cmd。' },
        { ts: '2026-10-29T01:30:21.036Z', tags: ['other'], text: filler + '薄壳模式 短路' },
    ]);
    const weakSnapshot = snapshotOf(weakFile);
    const weakConfig = { ...mod.Config({ journalPath: weakFile }), relativeCut: 0.9 };
    const weakChunk = chunkOf(weakSnapshot, '薄壳模式 短路');
    const base = {
        snapshot: weakSnapshot,
        query: BM25_QUERY,
        config: weakConfig,
        now: NOW,
    };
    const pure = recallMod.recall(base);
    const rag = recallMod.recall({
        ...base,
        semantic: { vectors: new Map([[weakChunk.hash, vectorAt(0.9)]]), queryVec: queryVector() },
    });

    const floor = Math.max(weakConfig.minScore, pure.topScore * weakConfig.relativeCut);
    const weakHit = rag.hits.find((hit) => hit.hash === weakChunk.hash);
    assert.ok(weakHit, 'BM25 弱于 floor 但语义强命中的片段必须能注入');
    assert.ok(weakHit.bm25Score < floor, '该片段确实低于 BM25 floor（' + weakHit.bm25Score + ' < ' + floor + '）');
    assert.ok(
        !pure.hits.some((hit) => hit.hash === weakChunk.hash),
        '对照组：纯 BM25 应被 relativeCut 挡住',
    );
    assert.ok(
        rag.hits.some((hit) => hit.hash !== weakChunk.hash),
        '强 BM25 命中仍应保留（floor 只挡弱 BM25，不放宽旧闸门）',
    );
}

/* ══════════════════════════════════════════════════════════════════════
 * 3. 无 key / 超时 / 补齐失败 → 与纯 BM25 完全一致且不抛
 * ══════════════════════════════════════════════════════════════════════ */
{
    // 3a. semantic 入参缺失 / queryVec 为 null → 调用与纯 BM25 逐字段一致。
    const pure = recallMod.recall({ snapshot: semanticSnapshot, query: SYNONYM_QUERY, config: semanticConfig, now: NOW });
    for (const semantic of [undefined, null, { vectors: new Map(), queryVec: null }]) {
        const degraded = recallMod.recall({
            snapshot: semanticSnapshot,
            query: SYNONYM_QUERY,
            config: semanticConfig,
            now: NOW,
            semantic,
        });
        assert.deepEqual(degraded, pure, '降级结果应与纯 BM25 完全一致（入参 ' + String(semantic) + '）');
    }
}

{
    // 3b. 查询抛错 / 挂起超时 → listener 不抛，注入结果与纯 BM25 一致。
    const pureBound = makeBound(bm25Config, undefined, bm25File);
    const pureDecision = await pureBound.listener(makePayload('s-pure', 1), nextWith(BM25_QUERY));
    assert.equal(pureDecision.messages.length, 2, '对照组：纯 BM25 应命中一条');
    pureBound.dispose();

    const rejectingBound = makeBound(
        bm25Config,
        { query: async () => { throw new Error('http 500'); }, ensure: () => Promise.resolve({ added: 0 }) },
        bm25File,
    );
    const rejecting = await rejectingBound.listener(makePayload('s-reject', 1), nextWith(BM25_QUERY));
    assert.deepEqual(textOfDecision(rejecting), textOfDecision(pureDecision), '查询失败应精确降级为纯 BM25');
    rejectingBound.dispose();

    const hangingBound = makeBound(
        { ...bm25Config, semanticTimeoutMs: 25 },
        { query: () => new Promise(() => {}), ensure: () => Promise.resolve({ added: 0 }) },
        bm25File,
    );
    const started = Date.now();
    const hanging = await hangingBound.listener(makePayload('s-hang', 1), nextWith(BM25_QUERY));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, '语义查询挂起时必须在超时后放弃（实际 ' + elapsed + 'ms）');
    assert.deepEqual(textOfDecision(hanging), textOfDecision(pureDecision), '超时应精确降级为纯 BM25');
    hangingBound.dispose();

    // 3c. 后台补齐失败/挂起：不能 await、不能抛、不能影响本轮注入。
    let ensureCalls = 0;
    const failingEnsure = makeBound(
        bm25Config,
        {
            query: async () => undefined,
            ensure: () => {
                ensureCalls += 1;
                return Promise.reject(new Error('warmup boom'));
            },
        },
        bm25File,
    );
    const failed = await failingEnsure.listener(makePayload('s-ensure-fail', 1), nextWith(BM25_QUERY));
    assert.deepEqual(textOfDecision(failed), textOfDecision(pureDecision), '补齐失败不影响注入');
    failingEnsure.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20)); // 让 ensure 的 rejection 被吞掉
    assert.equal(ensureCalls, 1);

    const slowEnsure = makeBound(
        bm25Config,
        { query: async () => undefined, ensure: () => new Promise(() => {}) },
        bm25File,
    );
    const slowStart = Date.now();
    const slow = await slowEnsure.listener(makePayload('s-ensure-slow', 1), nextWith(BM25_QUERY));
    assert.ok(Date.now() - slowStart < 200, '确保 ensure 不被 await（补齐慢不应拖住 turn）');
    assert.deepEqual(textOfDecision(slow), textOfDecision(pureDecision));
    slowEnsure.dispose();

    // 3d. 总开关关掉：连 query 都不发。
    let queried = 0;
    const offBound = makeBound(
        { ...bm25Config, semantic: false },
        { query: async () => { queried += 1; return undefined; }, ensure: () => Promise.resolve({ added: 0 }) },
        bm25File,
    );
    const off = await offBound.listener(makePayload('s-off', 1), nextWith(BM25_QUERY));
    assert.equal(queried, 0, 'semantic=false 时不应发起语义查询');
    assert.deepEqual(textOfDecision(off), textOfDecision(pureDecision));
    offBound.dispose();

    // 3e. 查询太短（< semanticMinQueryChars）不发 embedding。
    let shortQueried = 0;
    const shortBound = makeBound(
        { ...bm25Config, semanticMinQueryChars: 40 },
        { query: async () => { shortQueried += 1; return undefined; }, ensure: () => Promise.resolve({ added: 0 }) },
        bm25File,
    );
    await shortBound.listener(makePayload('s-short', 1), nextWith(BM25_QUERY));
    assert.equal(shortQueried, 0, '查询短于 semanticMinQueryChars 不应 embed');
    shortBound.dispose();
}

/* ══════════════════════════════════════════════════════════════════════
 * 4. 语义通道下预算 / 跨轮去重 / 工作区 / 记忆去重仍生效
 * ══════════════════════════════════════════════════════════════════════ */
{
    const recallWith = (extra = {}, options = {}) => recallMod.recall({
        snapshot: semanticSnapshot,
        query: SYNONYM_QUERY,
        config: semanticConfig,
        now: NOW,
        ...options,
        semantic: { vectors, queryVec: queryVector(), ...extra },
    });

    // 4a. 预算不足：装不下「前言 + 最小一条」时整轮丢弃，且原因可区分。
    const tight = recallWith({}, {
        config: { ...semanticConfig, maxChars: 120, maxTotalChars: 120 },
    });
    assert.equal(tight.text, null, '预算装不下时一条都不应注入');
    assert.equal(tight.reason, 'budget-too-small');
    assert.equal(tight.hits.length, 0);

    // 4b. 跨轮去重：已注入过的片段不再是语义候选（否则会绕过 BM25 的去重）。
    const skipped = recallWith({}, { skipChunkHashes: [h1.hash] });
    assert.ok(skipped.hits.every((hit) => hit.hash !== h1.hash), '已注入片段不应再召回');
    assert.equal(skipped.hits.length, 1);
    assert.equal(skipped.hits[0].hash, h2.hash);
    assert.ok(skipped.filtered.injected >= 1);

    // 4c. 工作区隔离：另一个工程的行即使语义最像也不进候选池。
    const scoped = recallWith({}, { cwd: POS_A });
    assert.equal(scoped.hits.length, 1, 'POS_A 会话不应召回 POS_B 的日志');
    assert.equal(scoped.hits[0].hash, h1.hash);
    assert.ok(scoped.filtered.workspace >= 1, '跨区行应计入 workspace 过滤');

    // 4d. 与 FACT/MEMORY 去重：语义命中但正文已在记忆文件里 → 不注入。
    const deduped = recallWith({}, { memoryTexts: [semanticEntries[0].text] });
    assert.equal(deduped.hits.length, 1, '已在记忆文件里的片段不应重复注入');
    assert.equal(deduped.hits[0].hash, h2.hash);
    assert.equal(deduped.filtered.duplicate, 1);
    assert.equal(deduped.semantic.gated, 1, '语义候选被记忆去重挡掉的条数应可见');

    // 4e. 同一 ts 只留一段：语义通道也走同一条第二道闸。
    const collisionFile = writeJournal('ts-collision', [
        { ts: '2026-10-30T01:30:21.036Z', tags: ['a'], text: '召回命中门槛：罕见词覆盖率判定（甲）。' },
        { ts: '2026-10-30T01:30:21.036Z', tags: ['b'], text: '召回命中门槛：罕见词覆盖率判定（乙）。' },
    ]);
    const collisionSnapshot = snapshotOf(collisionFile);
    const collisionVectors = fabricateVectors(collisionSnapshot, [['召回命中门槛', 0.9]]);
    const collision = recallMod.recall({
        snapshot: collisionSnapshot,
        query: SYNONYM_QUERY,
        config: semanticConfig,
        now: NOW,
        semantic: { vectors: collisionVectors, queryVec: queryVector() },
    });
    assert.equal(collision.hits.length, 1, '同一 ts 的两段语义命中只能注入一段');
}

/* ══════════════════════════════════════════════════════════════════════
 * 5. 宿主接线端到端：真 createSemanticRuntime + 假 fetch + 真 listener
 * ══════════════════════════════════════════════════════════════════════ */
{
    const cacheFile = join(home, 'memory', 'recall', 'embeddings.json');
    const runtimeConfig = mod.Config({
        journalPath: semanticFile,
        semanticApiKey: 'sk-test-offline-key',
        semanticTimeoutMs: 500,
        semanticWarmupBatch: 32,
    });

    const queryVec = queryVector();
    const embedMap = new Map();
    for (const chunk of semanticSnapshot.chunks) {
        embedMap.set(chunk.text, chunk.text.includes('召回命中门槛') ? vectorAt(0.9) : vectorAt(0.1));
    }
    embedMap.set(SYNONYM_QUERY, queryVec);

    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, auth: init.headers.authorization, inputs: body.input });
        return {
            ok: true,
            status: 200,
            async json() {
                return { data: body.input.map((text) => ({ embedding: Array.from(embedMap.get(text) ?? new Array(DIM).fill(0)) })) };
            },
            async text() { return ''; },
        };
    };

    try {
        const runtime = mod.createSemanticRuntime({
            config: runtimeConfig,
            logger: { info() {}, warn() {} },
            cacheFile,
        });
        assert.ok(runtime !== undefined, '有 key 时应建出语义运行时');
        assert.equal(runtime.index.size, 0, '首次启动缓存为空');
        assert.equal(existsSync(cacheFile), false);

        // 后台增量补齐（测试里显式 await 一次，模拟第一轮跑完后的缓存）。
        const warm = await runtime.index.ensure(semanticSnapshot.chunks);
        assert.ok(warm.added >= 4, '应补齐全部片段向量');
        assert.ok(runtime.index.size >= 4);
        assert.ok(existsSync(cacheFile), '补齐后应落盘向量缓存');
        assert.ok(statSync(cacheFile).size > 0);
        assert.ok(!readFileSync(cacheFile, 'utf8').includes('sk-test-offline-key'), '缓存文件里绝不能出现 apiKey');

        // 第二轮：语义召回注入。
        const bound = mod.createPreStepListener({
            config: runtimeConfig,
            store: mod.createJournalStore({ file: semanticFile, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 }),
            semanticIndex: runtime.index,
            memoryTextsFor: () => [],
            logger: { info() {}, warn() {} },
        });
        const decision = await bound.listener(makePayload('s-rag', 1), nextWith(SYNONYM_QUERY));
        assert.equal(decision.messages.length, 2, '语义命中应注入一条消息');
        assert.match(decision.messages[0].content[0].text, /召回命中门槛/);
        assert.equal(decision.messages[0].source.form, 'snapshot');
        bound.dispose();

        assert.ok(calls.length >= 1, '应真的走了假 fetch');
        const embedCall = calls.find((call) => call.inputs.includes(SYNONYM_QUERY));
        assert.ok(embedCall, '查询应被 embed');
        assert.equal(embedCall.auth, 'Bearer sk-test-offline-key', 'key 只出现在 Authorization 头里');
        assert.match(embedCall.url, /\/embeddings$/);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

/* ══════════════════════════════════════════════════════════════════════
 * 6. 设置页：apiKey 单独落盘 chmod 600，优先级 config > 文件 > env
 * ══════════════════════════════════════════════════════════════════════ */
function makePersonaMemory() {
    const items = new Map();
    return {
        items,
        service: {
            version: 1,
            settings: {
                register(item) {
                    if (items.has(item.id)) throw new Error('设置项 id 重复：' + item.id);
                    const entry = { ...item };
                    items.set(item.id, entry);
                    return {
                        id: entry.id,
                        get: () => entry.value,
                        async set(value) {
                            if (typeof entry.onChange === 'function') await entry.onChange(value);
                            entry.value = value;
                            return value;
                        },
                        update(patch) { Object.assign(entry, patch); },
                        dispose() { items.delete(entry.id); },
                    };
                },
                list: () => [...items.values()],
                has: (id) => items.has(id),
                async set(id, value) {
                    const entry = items.get(id);
                    if (entry === undefined) throw new Error('未知的设置项：' + id);
                    if (typeof entry.onChange === 'function') await entry.onChange(value);
                    entry.value = value;
                    return entry.value;
                },
            },
        },
    };
}

function makeCtx(services) {
    const ctx = {
        logger: { info() {}, warn() {} },
        on() {},
        effect(fn) { return fn(); },
        get(key) { return services[key]; },
        inject(deps, callback) {
            callback({ get: (key) => services[key], effect: (fn) => fn() });
        },
    };
    return ctx;
}

{
    const ragFile = settings.ragConfigPath();
    assert.equal(ragFile, join(home, 'memory', 'recall-rag.json'));

    // 6a. 优先级：config > 文件 > env。
    assert.equal(settings.resolveSemanticApiKey({}), '', '都没有时为空串');
    process.env.SILICONFLOW_API_KEY = 'env-key';
    assert.equal(settings.resolveSemanticApiKey({}), 'env-key', 'env 兜底');
    settings.writeRagConfig({ apiKey: 'file-key', model: 'BAAI/bge-m3', baseURL: 'https://api.siliconflow.cn/v1' });
    assert.equal(settings.resolveSemanticApiKey({}), 'file-key', '文件应压过 env');
    assert.equal(
        settings.resolveSemanticApiKey({ semanticApiKey: 'config-key' }),
        'config-key',
        'config 应压过文件',
    );
    delete process.env.SILICONFLOW_API_KEY;
    assert.equal(settings.resolveSemanticApiKey({}), 'file-key', '删掉 env 不应影响文件');
    assert.equal(statSync(ragFile).mode & 0o777, 0o600, 'recall-rag.json 必须是 600');
    assert.equal(settings.readRagConfig().apiKey, 'file-key');
    assert.deepEqual(settings.readRagConfig(join(home, 'memory', 'nope.json')), {}, '不存在应返回空对象');

    // 6b. 设置页回写：key 只写侧车，recall.json（覆盖层）里绝不能出现 key。
    const ragPath = settings.recallOverridesPath();
    const pm = makePersonaMemory();
    const ctx = makeCtx({ personaMemory: pm.service });
    mod.apply(ctx, { journalPath: bm25File });

    assert.equal(pm.items.get('recall.semanticApiKey').value, '', '页面不回显 key');
    await pm.service.settings.set('recall.semanticApiKey', 'sk-test-page-key');
    const saved = settings.readRagConfig();
    assert.equal(saved.apiKey, 'sk-test-page-key');
    assert.equal(statSync(ragFile).mode & 0o777, 0o600);
    if (existsSync(ragPath)) {
        assert.ok(!readFileSync(ragPath, 'utf8').includes('sk-test-page-key'), 'recall.json 里绝不能出现 key');
        assert.ok(!('semanticApiKey' in JSON.parse(readFileSync(ragPath, 'utf8'))), '覆盖层不存 apiKey 键');
    }

    // 留空 = 不改动。
    await pm.service.settings.set('recall.semanticApiKey', '');
    assert.equal(settings.readRagConfig().apiKey, 'sk-test-page-key', '留空不应清空已有 key');

    // 普通语义项仍写 recall.json。
    await pm.service.settings.set('recall.semanticMinSimilarity', '0.6');
    const overrides = JSON.parse(readFileSync(ragPath, 'utf8'));
    assert.equal(overrides.semanticMinSimilarity, 0.6);
    assert.equal(overrides.semanticApiKey, undefined, '覆盖层不应出现 apiKey');

    // 模型名写回侧车（保留 key）。
    await pm.service.settings.set('recall.semanticModel', 'BAAI/bge-large-zh-v1.5');
    const afterModel = settings.readRagConfig();
    assert.equal(afterModel.apiKey, 'sk-test-page-key', '改模型不应冲掉 key');
    assert.equal(afterModel.model, 'BAAI/bge-large-zh-v1.5');

    // 非法值拒绝且不落盘。
    await assert.rejects(
        async () => pm.service.settings.set('recall.semanticMinSimilarity', '1.5'),
        /不能大于 1/,
    );
    await assert.rejects(
        async () => pm.service.settings.set('recall.semanticModel', '   '),
        /不能为空/,
    );
}

{
    // 6c. 没有 key：启动 info 一条并纯 BM25 工作。
    const ragFile = settings.ragConfigPath();
    rmSync(ragFile, { force: true });
    const infos = [];
    const ctx = {
        logger: { info: (message) => infos.push(message), warn: (message) => infos.push(message) },
        on() {},
        effect(fn) { return fn(); },
        get() { return undefined; },
    };
    mod.apply(ctx, { journalPath: bm25File });
    assert.ok(infos.some((line) => /语义召回未启用：没配置 API key/.test(line)), '无 key 时应 info 一条');
    assert.ok(!infos.some((line) => line.includes('sk-')), '启动日志绝不能带 key');
}

rmSync(home, { recursive: true, force: true });
console.log('✓ rag-integration.test.mjs 全部通过');
