/**
 * 语义内核离线测试：嵌入客户端（fake fetch，零联网）、float16 编解码、cosine 边界、
 * JSON 侧车缓存（原子写 / 容错 / 剪枝 / LRU）。
 *
 * 为什么全部离线：这些用例要在手机 proot 里跑、也不能消耗免费额度；嵌入服务的行为
 * （分批、超时、5xx、malformed）用 fake fetch 完全可控，反而比打真接口更能钉住边界。
 *
 * 跑法：node test/semantic.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    CACHE_VERSION,
    DEFAULT_BASE_URL,
    DEFAULT_BATCH_SIZE,
    DEFAULT_DIM,
    DEFAULT_MODEL,
    DEFAULT_TIMEOUT_MS,
    EmbeddingError,
    cosineSimilarity,
    createEmbeddingClient,
    createVectorStore,
    decodeVector,
    encodeVector,
} from '../lib/semantic.js';

const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-semantic-'));

/** 可控的 Fake fetch：记录每次调用，由 handler 决定返回什么。 */
function makeFetch(handler) {
    const calls = [];
    const impl = async (url, init) => {
        const call = { url, init, body: JSON.parse(String(init.body)) };
        calls.push(call);
        return handler(call, calls.length - 1);
    };
    return { impl, calls };
}

/** OpenAI 兼容的成功响应。 */
function successResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    };
}

/** 错误响应（只有 text()，模拟网关返回 HTML）。 */
function errorResponse(status, body) {
    return {
        ok: false,
        status,
        text: async () => body,
    };
}

/**
 * 把输入文本映射成固定长度的假向量，方便断言「顺序有没有错位」。
 *
 * 值只用整数与 0.5 的倍数：这些数在 float32 里精确可表示，deepEqual 才能直接比，
 * 不会因为 0.1 的二进制舍入把「顺序错位」的断言变成「精度不符」的误报。
 */
function vectorFor(text, dim = 4) {
    const seed = [...text].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    return Array.from({ length: dim }, (_, index) => (seed % 17) + index * 0.5);
}

/** 按要求长度造确定性向量（LCG，测试不联网也要有「随机感」）。 */
function makeVector(dim, seed) {
    const vec = new Float32Array(dim);
    let state = seed >>> 0;
    for (let index = 0; index < dim; index += 1) {
        state = (1664525 * state + 1013904223) >>> 0;
        vec[index] = (state / 4294967296) * 2 - 1;
    }
    return vec;
}

/* ══ 1. 常量：与契约表格逐项对齐（上层默认值直接引用，不许各写一份） ══ */
{
    assert.equal(DEFAULT_MODEL, 'BAAI/bge-m3');
    assert.equal(DEFAULT_BASE_URL, 'https://api.siliconflow.cn/v1');
    assert.equal(DEFAULT_TIMEOUT_MS, 4000);
    assert.equal(DEFAULT_BATCH_SIZE, 32);
    assert.equal(DEFAULT_DIM, 1024);
    assert.equal(CACHE_VERSION, 1);
}

/* ══ 2. 分批 + 顺序 + 请求形状（URL / header / body） ══ */
{
    const { impl, calls } = makeFetch((call) => successResponse({
        data: call.body.input.map((text) => ({ embedding: vectorFor(text) })),
    }));
    const client = createEmbeddingClient({
        apiKey: 'test-key',
        baseURL: 'https://fake.test/v1/',
        model: 'BAAI/bge-m3',
        batchSize: 2,
        fetchImpl: impl,
    });
    const texts = ['aa', 'bbb', 'cccc', 'ddddd', 'eeeeee'];
    const vectors = await client.embed(texts);

    assert.equal(calls.length, 3, '5 条 / 每批 2 条 → 3 次请求');
    assert.deepEqual(calls.map((call) => call.body.input.length), [2, 2, 1], '最后一批只发剩 1 条');
    assert.equal(calls[0].url, 'https://fake.test/v1/embeddings', 'baseURL 去掉尾斜杠再拼 /embeddings');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
    assert.equal(calls[0].body.model, 'BAAI/bge-m3');
    assert.equal(calls[0].body.encoding_format, 'float');
    assert.ok(Array.isArray(calls[0].body.input));

    assert.equal(vectors.length, texts.length, '返回条数与输入一一对应');
    for (let index = 0; index < texts.length; index += 1) {
        assert.ok(vectors[index] instanceof Float32Array);
        assert.deepEqual([...vectors[index]], vectorFor(texts[index]), '第 ' + index + ' 条不能错位');
    }
    assert.equal(client.model, 'BAAI/bge-m3');
    assert.equal(client.baseURL, 'https://fake.test/v1');
}

/* ══ 3. 服务端按 index 乱序回填：仍按入参归位（并行网关的常见行为） ══ */
{
    const { impl } = makeFetch((call) => successResponse({
        data: call.body.input.map((text, index) => ({
            index,
            embedding: vectorFor(text),
        })).reverse(),
    }));
    const client = createEmbeddingClient({ apiKey: 'test-key', batchSize: 4, fetchImpl: impl });
    const texts = ['one', 'two', 'three'];
    const vectors = await client.embed(texts);
    for (let index = 0; index < texts.length; index += 1) {
        assert.deepEqual([...vectors[index]], vectorFor(texts[index]), 'index 字段必须优先于到达顺序');
    }
}

/* ══ 4. 空串：不发请求、原地给零向量，且不影响其它条的顺序 ══ */
{
    const { impl, calls } = makeFetch((call) => successResponse({
        data: call.body.input.map((text) => ({ embedding: vectorFor(text) })),
    }));
    const client = createEmbeddingClient({ apiKey: 'test-key', timeoutMs: 1000, fetchImpl: impl });
    const vectors = await client.embed(['aa', '   ', 'bbb']);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.input, ['aa', 'bbb'], '空白串不该进请求体（省配额）');
    assert.equal(vectors.length, 3);
    assert.equal(vectors[1].length, 1024, '零向量按默认维度给长度');
    assert.ok(vectors[1].every((value) => value === 0), '空串给零向量');
    assert.deepEqual([...vectors[0]], vectorFor('aa'));
    assert.deepEqual([...vectors[2]], vectorFor('bbb'));

    assert.deepEqual(await client.embed([]), [], '空数组不请求也不报错');
    assert.equal(calls.length, 1);
}

/* ══ 5. 没 key：构造不抛，第一次 embed 抛 no-key，且一次请求都不发 ══ */
{
    const { impl, calls } = makeFetch(() => successResponse({ data: [{ embedding: [1] }] }));
    const client = createEmbeddingClient({ fetchImpl: impl });
    await assert.rejects(client.embed(['x']), (error) => {
        assert.ok(error instanceof EmbeddingError);
        assert.equal(error.code, 'no-key');
        return true;
    });
    assert.equal(calls.length, 0);

    // 空白 key 视同没配（设置页被清空的典型状态）。
    const blank = createEmbeddingClient({ apiKey: '   ', fetchImpl: impl });
    await assert.rejects(blank.embed(['x']), (error) => error.code === 'no-key');
}

/* ══ 6. HTTP 错：code=http、message 带 status 与 body 前 200 字、绝不带 key ══ */
{
    const { impl } = makeFetch(() => errorResponse(503, 'gateway boom ' + 'x'.repeat(500)));
    const client = createEmbeddingClient({ apiKey: 'sk-secret-should-never-leak', fetchImpl: impl });
    await assert.rejects(client.embed(['x']), (error) => {
        assert.equal(error.code, 'http');
        assert.match(error.message, /503/);
        assert.match(error.message, /gateway boom/);
        assert.ok(error.message.length < 200 + 40, 'body 只截前 200 字');
        assert.ok(!error.message.includes('sk-secret'), 'apiKey 绝不能进错误消息');
        return true;
    });

    // 网络层异常也归 http：上层只关心「这次拿不到」。fake fetch 里直接 throw 最像连接被重置。
    const broken = createEmbeddingClient({
        apiKey: 'k',
        fetchImpl: async () => {
            throw new Error('ECONNRESET');
        },
    });
    await assert.rejects(broken.embed(['x']), (error) => {
        assert.equal(error.code, 'http');
        assert.match(error.message, /ECONNRESET/);
        return true;
    });
}

/* ══ 7. 超时：整条流程（连接 + body）都在超时内，fake fetch 永不 resolve 也判得出来 ══ */
{
    let aborted = false;
    const client = createEmbeddingClient({
        apiKey: 'k',
        timeoutMs: 40,
        fetchImpl: (url, init) => {
            init.signal?.addEventListener?.('abort', () => {
                aborted = true;
            });
            return new Promise(() => {}); // 永不 settle
        },
    });
    const started = Date.now();
    await assert.rejects(client.embed(['x']), (error) => {
        assert.equal(error.code, 'timeout');
        assert.match(error.message, /40ms/);
        return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 30, '应当等满超时再判，实际 ' + elapsed + 'ms');
    assert.ok(elapsed < 1000, '不能把整轮拖死，实际 ' + elapsed + 'ms');
    assert.equal(aborted, true, '超时时应顺手 abort 真实请求');
}

/* ══ 8. malformed：条数不符 / embedding 非数组 / 非有限数 / 坏 JSON ══ */
{
    const cases = [
        ['条数不符', () => successResponse({ data: [{ embedding: [1, 2] }] }), 2],
        ['embedding 非数组', () => successResponse({ data: [{ embedding: 'nope' }, { embedding: [1] }] }), 2],
        ['embedding 为空', () => successResponse({ data: [{ embedding: [] }, { embedding: [1] }] }), 2],
        ['非有限数', () => successResponse({ data: [{ embedding: [1, 'x'] }, { embedding: [1] }] }), 2],
        ['坏 JSON', () => ({ ok: true, status: 200, text: async () => 'not-json' }), 1],
    ];
    for (const [label, handler, count] of cases) {
        const { impl } = makeFetch(handler);
        const client = createEmbeddingClient({ apiKey: 'k', fetchImpl: impl });
        await assert.rejects(client.embed(Array.from({ length: count }, (_, index) => 't' + index)), (error) => {
            assert.equal(error.code, 'malformed', label + ' 应是 malformed');
            return true;
        }, label);
    }
}

/* ══ 9. empty：data 为空数组（key 失效 / 无权限的常见形状） ══ */
{
    const { impl } = makeFetch(() => successResponse({ data: [] }));
    const client = createEmbeddingClient({ apiKey: 'k', fetchImpl: impl });
    await assert.rejects(client.embed(['x']), (error) => {
        assert.equal(error.code, 'empty');
        return true;
    });
}

/* ══ 10. 入参类型：非数组 / 非字符串直接 TypeError，不静默拼字符串 ══ */
{
    const client = createEmbeddingClient({ apiKey: 'k', fetchImpl: async () => successResponse({ data: [] }) });
    await assert.rejects(client.embed('x'), TypeError);
    await assert.rejects(client.embed(['x', 42]), TypeError);
}

/* ══ 11. float16 round-trip：相对误差 < 1e-2、绝对误差 < 1e-3（契约第八节的精度要求） ══ */
{
    const values = [0, 1, -1, 0.5, -0.5, 0.1, -0.3, 0.3333, 123.456, 1024.5, 65504, -65504, 1e-3, 1e-4, 6.1e-5];
    const vector = Float32Array.from(values);
    const encoded = encodeVector(vector);
    assert.equal(typeof encoded, 'string');
    assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/, '标准 base64');
    assert.equal(encoded.length, Math.ceil((values.length * 2) / 3) * 4);

    const decoded = decodeVector(encoded, values.length);
    assert.equal(decoded.length, values.length);
    for (let index = 0; index < values.length; index += 1) {
        const expected = values[index];
        const actual = decoded[index];
        const absolute = Math.abs(actual - expected);
        if (Math.abs(expected) >= 1e-3) {
            // half 的相对精度恒定（约 4.9e-4），所以「相对」这一条对大小值都成立。
            const relative = absolute / Math.abs(expected);
            assert.ok(relative < 1e-2, '第 ' + index + ' 项相对误差 ' + relative);
        }
        // 「绝对 < 1e-3」只在嵌入分量的真实量级（[-1,1]，bge-m3 已归一化）里有意义：
        // 123.456 这种大数的 half 步长天然是 0.0625，用它去卡绝对误差等于卡 float16 的物理下限。
        if (Math.abs(expected) <= 1) {
            assert.ok(absolute < 1e-3, '第 ' + index + ' 项绝对误差 ' + absolute);
        }
    }

    // 极小值（小于 half 最小次正规数）落 0：误差仍是「绝对 < 1e-3」而不是 NaN/Inf。
    const tiny = decodeVector(encodeVector(Float32Array.from([1e-12])), 1);
    assert.equal(tiny[0], 0);
}

/* ══ 12. float16 特殊值：±Inf / NaN / ±0 / 最大正常数 ══ */
{
    const special = decodeVector(encodeVector(Float32Array.from([
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NaN,
        0,
        -0,
        65504,
    ])), 6);
    assert.equal(special[0], Number.POSITIVE_INFINITY);
    assert.equal(special[1], Number.NEGATIVE_INFINITY);
    assert.ok(Number.isNaN(special[2]), 'NaN 应保留为 NaN');
    assert.equal(special[3], 0);
    // 符号零保留符号（=== 0 为真即可，cosine 不区分 ±0）。
    assert.ok(special[4] === 0, '-0 与 0 等价');
    // 超过 65504 的 float32 值在 half 里上溢成 Inf（不是 0，也不是回绕）。
    assert.equal(decodeVector(encodeVector(Float32Array.from([1e6])), 1)[0], Number.POSITIVE_INFINITY);
}

/* ══ 13. 编解码长度是「身份」：维度不符、空串、非法 base64 都要显式拒绝 ══ */
{
    const encoded = encodeVector(new Float32Array(8));
    assert.equal(encoded.length, Math.ceil((8 * 2) / 3) * 4);
    assert.equal(decodeVector(encoded, 8).length, 8);

    assert.throws(() => decodeVector(encoded, 4), RangeError, '维度不符应拒绝，不能把错位向量当真');
    assert.throws(() => decodeVector('', 8), TypeError);
    assert.throws(() => decodeVector(encoded, 0), TypeError);
    assert.throws(() => encodeVector('nope'), TypeError);
}

/* ══ 14. 1000 维缓存的体积：契约要求 1000 条 ≲ 2.5 MB（float16 + base64 的物理下限） ══ */
{
    const vector = makeVector(1024, 7);
    const encoded = encodeVector(vector);
    assert.equal(encoded.length, 2732, '1024 维 × 2 字节 = 2048 字节 → 2732 字符 base64');
    assert.ok(encoded.length * 1000 < 2.9 * 1024 * 1024, '1000 条 ≈ 2.73 MB（含 JSON 壳仍低于 2.9 MB）');
}

/* ══ 15. cosine 边界：同向 1、反向 -1、正交 0、长度不等 / 零向量一律 0 ══ */
{
    const left = Float32Array.from([1, 2, 3]);
    assert.equal(cosineSimilarity(left, left), 1);
    assert.equal(cosineSimilarity(left, Float32Array.from([-1, -2, -3])), -1);
    // 正交但避开了 1/3 这类 float32 除不尽的数（否则点积是 1e-9 级残差，卡的就不是正交性了）。
    assert.equal(cosineSimilarity(left, Float32Array.from([0, 3, -2])), 0); // 0+6-6=0
    assert.equal(cosineSimilarity(left, Float32Array.from([1, 2])), 0, '长度不等不可比');
    assert.equal(cosineSimilarity(new Float32Array(3), left), 0, '零向量没有方向');
    assert.equal(cosineSimilarity(new Float32Array(0), new Float32Array(0)), 0);
    assert.equal(cosineSimilarity(Float32Array.from([Number.NaN, 1]), left), 0, 'NaN 不能传染');

    // 1024 维：与手算一致，且 clamp 不会越界。
    const a = makeVector(1024, 11);
    const b = makeVector(1024, 12);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < 1024; index += 1) {
        dot += a[index] * b[index];
        normA += a[index] * a[index];
        normB += b[index] * b[index];
    }
    const expected = dot / Math.sqrt(normA * normB);
    assert.ok(Math.abs(cosineSimilarity(a, b) - expected) < 1e-9);
    const value = cosineSimilarity(a, b);
    assert.ok(value >= -1 && value <= 1);
}

/* ══ 16. store：putMany → save → 新实例 load，向量按 float16 精度原样回来 ══ */
{
    const file = join(home, 'store', 'embeddings.json');
    const store = createVectorStore({ file, dim: 8 });
    const entries = [
        { hash: 'h1', vec: makeVector(8, 1) },
        { hash: 'h2', vec: makeVector(8, 2) },
        { hash: 'h3', vec: makeVector(8, 3) },
    ];
    assert.deepEqual(store.putMany(entries), { added: 3, pruned: 0, kept: 3, evicted: 0 });
    assert.equal(store.size, 3);
    assert.equal(store.dim, 8);
    assert.equal(store.file, file);
    assert.equal(store.model, DEFAULT_MODEL, '默认模型与嵌入客户端一致');

    // 原子写：目录里只该有正式文件，不该留 tmp。
    const written = store.save();
    assert.ok(written.bytes > 0);
    assert.equal(written.count, 3);
    assert.deepEqual(readdirSync(join(home, 'store')), ['embeddings.json'], 'save 后不留临时文件');

    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.v, CACHE_VERSION);
    assert.equal(raw.model, DEFAULT_MODEL);
    assert.equal(raw.dim, 8);
    assert.equal(typeof raw.vectors.h1, 'string', '落盘用 base64 字符串');
    assert.deepEqual(Object.keys(raw.vectors).sort(), ['h1', 'h2', 'h3'], '只存 hash → base64，不夹带元数据');

    const loaded = createVectorStore({ file, dim: 8 });
    const report = loaded.load();
    assert.equal(report.ok, true);
    assert.equal(report.reason, 'ok');
    assert.equal(report.count, 3);
    assert.equal(loaded.size, 3);
    for (const entry of entries) {
        const vector = loaded.get(entry.hash);
        assert.ok(vector instanceof Float32Array);
        for (let index = 0; index < 8; index += 1) {
            assert.ok(Math.abs(vector[index] - entry.vec[index]) < 1e-3, 'float16 往返误差应小于 1e-3');
        }
    }
}

/* ══ 17. load 容错：不存在 / 坏 JSON / 版本不符 / 模型不符 / 维度不符 → 空库，不抛 ══ */
{
    const warnings = [];
    const infos = [];
    const log = {
        warn: (message) => warnings.push(message),
        info: (message) => infos.push(message),
    };
    const cases = [
        ['不存在', undefined, 'missing'],
        ['坏 JSON', 'not-json-at-all', 'bad-json'],
        ['版本不符', JSON.stringify({ v: 2, model: DEFAULT_MODEL, dim: 4, vectors: {} }), 'version'],
        ['模型不符', JSON.stringify({ v: 1, model: 'other/model', dim: 4, vectors: {} }), 'model'],
        ['维度不符', JSON.stringify({ v: 1, model: DEFAULT_MODEL, dim: 1024, vectors: {} }), 'dim'],
    ];
    for (const [label, body, expectedReason] of cases) {
        const file = join(home, 'tolerant-' + expectedReason + '.json');
        if (body !== undefined) writeFileSync(file, body, 'utf8');
        const store = createVectorStore({ file, dim: 4, log });
        const beforeWarnings = warnings.length;
        const beforeInfos = infos.length;
        const report = store.load();
        assert.equal(report.ok, expectedReason === 'missing', label + ' ok 位');
        assert.equal(report.reason, expectedReason, label + ' 原因码');
        assert.equal(report.count, 0, label + ' 应按空库');
        assert.equal(store.size, 0);
        // 「首次启动还没有缓存」是正常状态：只记 info，不进 warn（否则每轮一条噪声）。
        if (expectedReason === 'missing') {
            assert.equal(warnings.length, beforeWarnings, label + ' 不该 warn');
            assert.equal(infos.length, beforeInfos + 1, label + ' 应记一条 info');
        } else {
            assert.equal(warnings.length, beforeWarnings + 1, label + ' 应记一条 warn');
            assert.equal(infos.length, beforeInfos, label + ' 坏文件不该走 info');
        }
    }
    assert.ok(warnings.every((message) => /向量缓存/.test(message)), 'warn 文案要能 grep 到');
    assert.ok(infos.every((message) => /向量缓存/.test(message)), 'info 文案要能 grep 到');
}

/* ══ 17b. 函数形态的 log 只收 warn：缺文件时一条也不该打到它头上 ══ */
{
    const seen = [];
    const store = createVectorStore({ file: join(home, 'never-written.json'), dim: 4, log: (message) => seen.push(message) });
    assert.equal(store.load().reason, 'missing');
    assert.equal(seen.length, 0, '函数形态替身只收 warn，而缺文件是 info，所以不该有任何输出');
}

/* ══ 18. load 单条容错：一条坏向量只跳过这一条，不整份重建 ══ */
{
    const file = join(home, 'partial.json');
    const good = encodeVector(makeVector(4, 5));
    writeFileSync(file, JSON.stringify({
        v: 1,
        model: DEFAULT_MODEL,
        dim: 4,
        vectors: { good, bad: 'AAAA', junk: 42 },
    }), 'utf8');

    const warnings = [];
    const store = createVectorStore({ file, dim: 4, log: { warn: (message) => warnings.push(message) } });
    const report = store.load();
    assert.equal(report.ok, true);
    assert.equal(report.skipped, 2, '坏 base64 与非字符串各算一条');
    assert.equal(store.size, 1);
    assert.ok(store.get('good') instanceof Float32Array);
    assert.equal(store.get('bad'), undefined);
    assert.equal(warnings.length, 1, '跳过计数只 warn 一次');
}

/* ══ 19. putMany 剪枝：chunk 重建后 hash 变了，不在 validHashes 里的旧向量要清掉 ══ */
{
    const file = join(home, 'prune.json');
    const store = createVectorStore({ file, dim: 4 });
    store.putMany([
        { hash: 'old-1', vec: makeVector(4, 1) },
        { hash: 'old-2', vec: makeVector(4, 2) },
        { hash: 'keep', vec: makeVector(4, 3) },
    ]);

    // 传数组、传 Set 都支持（宿主手里可能是 Array.from(set)）。
    const report = store.putMany([], { validHashes: ['keep', 'new-but-absent'] });
    assert.deepEqual(report, { added: 0, pruned: 2, kept: 1, evicted: 0 });
    assert.equal(store.get('old-1'), undefined);
    assert.equal(store.get('old-2'), undefined);

    // 空集合 = 全部剪掉（这一轮没有任何 chunk 有效，缓存就该清空）。
    assert.deepEqual(store.putMany([], { validHashes: new Set() }), { added: 0, pruned: 1, kept: 0, evicted: 0 });
    assert.equal(store.size, 0);
}

/* ══ 20. putMany 校验：空 hash / 维度不符跳过并计数，其余照写 ══ */
{
    const store = createVectorStore({ file: join(home, 'validate.json'), dim: 4, log: () => {} });
    const report = store.putMany([
        { hash: '', vec: makeVector(4, 1) },
        { hash: 'right', vec: makeVector(4, 2) },
        { hash: 'wrong-dim', vec: makeVector(8, 3) },
        { hash: 'array-form', vec: [0.1, 0.2, 0.3, 0.4] },
        { vec: makeVector(4, 4) },
    ]);
    assert.equal(report.added, 2, '只有 hash 与维度都合格的才写入');
    assert.equal(store.size, 2);
    assert.ok(store.get('array-form') instanceof Float32Array);
    assert.equal(store.get('wrong-dim'), undefined);
}

/* ══ 21. maxVectors：超出按 LRU 淘汰，get 命中会把条目挪到队尾续命 ══ */
{
    const store = createVectorStore({ file: join(home, 'lru.json'), dim: 2, maxVectors: 2 });
    store.putMany([
        { hash: 'a', vec: makeVector(2, 1) },
        { hash: 'b', vec: makeVector(2, 2) },
    ]);
    assert.deepEqual(store.putMany([{ hash: 'c', vec: makeVector(2, 3) }]), { added: 1, pruned: 0, kept: 2, evicted: 1 });
    assert.equal(store.get('a'), undefined, '最久未用的 a 先淘汰');
    assert.ok(store.get('b') instanceof Float32Array);

    // b 刚被 get 过 → 再插 d 时应淘汰 c，而不是 b。
    store.get('b');
    store.putMany([{ hash: 'd', vec: makeVector(2, 4) }]);
    assert.ok(store.get('b') instanceof Float32Array, '被读过的条目不该先淘汰');
    assert.equal(store.get('c'), undefined);
    assert.equal(store.size, 2);

    // 覆盖同 hash 不应产生第二条，也不该把它顶到队首去先淘汰别人。
    store.putMany([{ hash: 'b', vec: makeVector(2, 9) }]);
    assert.equal(store.size, 2);
}

/* ══ 22. load 也守 maxVectors：文件比上限大就按文件顺序（旧→新）淘汰 ══ */
{
    const file = join(home, 'load-trim.json');
    writeFileSync(file, JSON.stringify({
        v: 1,
        model: DEFAULT_MODEL,
        dim: 2,
        vectors: {
            a: encodeVector(makeVector(2, 1)),
            b: encodeVector(makeVector(2, 2)),
            c: encodeVector(makeVector(2, 3)),
        },
    }), 'utf8');
    const warnings = [];
    const store = createVectorStore({ file, dim: 2, maxVectors: 2, log: { warn: (message) => warnings.push(message) } });
    const report = store.load();
    assert.equal(report.count, 2);
    assert.equal(report.evicted, 1);
    assert.equal(store.get('a'), undefined);
    assert.equal(store.size, 2);
    assert.ok(warnings.some((message) => /超过上限/.test(message)));
}

/* ══ 23. clear：清内存不算错，save 后文件变空库（可被 load 回来） ══ */
{
    const file = join(home, 'clear.json');
    const store = createVectorStore({ file, dim: 4 });
    store.putMany([
        { hash: 'h1', vec: makeVector(4, 1) },
        { hash: 'h2', vec: makeVector(4, 2) },
    ]);
    store.save();
    assert.deepEqual(store.clear(), { cleared: 2 });
    assert.equal(store.size, 0);
    assert.equal(store.get('h1'), undefined);

    store.save();
    const reopened = createVectorStore({ file, dim: 4, log: () => {} });
    assert.equal(reopened.load().count, 0);
    assert.equal(reopened.size, 0);
}

/* ══ 24. 构造校验 + save 建目录：路径必须给，目录不存在要自己建 ══ */
{
    assert.throws(() => createVectorStore({}), TypeError);
    assert.throws(() => createVectorStore({ file: '   ' }), TypeError);

    const file = join(home, 'deep', 'nested', 'dir', 'embeddings.json');
    const store = createVectorStore({ file, dim: 2, model: 'BAAI/bge-m3' });
    store.putMany([{ hash: 'x', vec: makeVector(2, 1) }]);
    store.save();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.dim, 2);
    assert.equal(Object.keys(raw.vectors).length, 1);
}

rmSync(home, { recursive: true, force: true });
console.log('✓ semantic.test.mjs 全部通过（25 组）');
