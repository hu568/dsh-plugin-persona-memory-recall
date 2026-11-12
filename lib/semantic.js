/**
 * 语义召回内核：嵌入请求、向量编解码、文件侧车缓存。
 *
 * 为什么这一层处处都能「降级」：语义通道只是给 BM25 补漏（同义改写召不回的那类），
 * 不是召回的必需品。没 key、超时、5xx、缓存文件坏了，都只该少一条线索，不该让一轮
 * 对话失败；所以外部依赖（fetch）可注入，所有失败都以 EmbeddingError 抛出，由上层
 * 记 warn 后回退纯 BM25。
 *
 * 为什么手写 float16：1024 维 float32 直接 base64 是约 5.4 KB/条，1000 条 chunk 就是
 * 5.4 MB 的侧车；float16 把体积砍半（约 2.7 KB/条），对 cosine 排序的影响（约 1e-3）
 * 远小于相似度门槛（0.55）。为守住「零 npm 依赖」的硬约束，half 转换按 IEEE 754 手写。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 嵌入模型：bge-m3 免费、1024 维、中英混排都稳，是这套日志语料（中英混排）的默认选择。 */
export const DEFAULT_MODEL = 'BAAI/bge-m3';

/** 硅基流动的 OpenAI 兼容入口；单独抽出来是为了让「换供应商」只改一个字符串。 */
export const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';

/**
 * 单次 HTTP 请求的超时。
 *
 * 为什么是 4 秒：召回发生在每一轮的用户消息之前，语义通道最多只能给一轮加几百毫秒
 * 的等待；实测单条 0.28s、batch32 3.6s，4 秒既能容下 32 条一批，又不会把一轮拖进
 * 十秒级。真超时就按「本轮不召回语义」处理，下一轮还有机会。
 */
export const DEFAULT_TIMEOUT_MS = 4000;

/** 每批条数：32 是实测吞吐与延迟的平衡点（一次请求 3.6s，再大就逼近超时）。 */
export const DEFAULT_BATCH_SIZE = 32;

/**
 * 默认向量维度。
 *
 * 契约没写这个参数，但空串输入要「不发请求直接给零向量」——零向量必须有个长度，
 * 而请求失败时又拿不到服务端维度。bge-m3 固定 1024 维，这里作为默认值与缓存校验依据；
 * 换模型时通过 createEmbeddingClient({ dimension }) 与 createVectorStore({ dim }) 覆盖。
 */
export const DEFAULT_DIM = 1024;

/** 侧车结构版本：结构变了就换版本号，旧缓存按「版本不符」整份丢弃重建（缓存可丢）。 */
export const CACHE_VERSION = 1;

/** 错误响应只截前 200 字：够定位（是网关 502 还是 key 失效），又不会把大段 HTML 塞进日志。 */
const BODY_SNIPPET_CHARS = 200;

/**
 * 语义通道的失败类型。
 *
 * 为什么要有 code 而不是只看 message：上层要按「永久失败」（no-key / http 401）与
 * 「临时失败」（timeout / 5xx）决定是否继续重试、是否压日志；靠字符串匹配太脆。
 */
export class EmbeddingError extends Error {
    /**
     * @param {'no-key' | 'http' | 'timeout' | 'malformed' | 'empty'} code
     * @param {string} message 已脱敏的消息：绝不含 apiKey。
     */
    constructor(code, message) {
        super(message);
        this.name = 'EmbeddingError';
        this.code = code;
    }
}

/** 抹平空白并截断，避免把整页错误 HTML 写进日志。 */
function snippet(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length <= BODY_SNIPPET_CHARS ? text : text.slice(0, BODY_SNIPPET_CHARS - 1) + '…';
}

/** 非空字符串否则回落，选项解析用（构造不该因为一个空串就抛）。 */
function textOr(value, fallback) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** 正数否则回落。 */
function positiveOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 正整数否则回落（batchSize / maxVectors / dim 这类）。 */
function integerOr(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * 建嵌入客户端。
 *
 * 构造**不抛**（缺 key 的第一种报错要落在第一次 embed 上）：宿主在 apply() 里建客户端，
 * 那时还没发过请求，构造期抛错会把整个插件启动打断，而契约要求「没 key 就纯 BM25」。
 *
 * @param {{
 *   apiKey?: string,
 *   baseURL?: string,
 *   model?: string,
 *   timeoutMs?: number,
 *   batchSize?: number,
 *   dimension?: number,
 *   fetchImpl?: (url: string, init: any) => Promise<any>,
 * }} [options]
 * @returns {{ embed: (texts: string[]) => Promise<Float32Array[]>, model: string, baseURL: string, dim: number }}
 */
export function createEmbeddingClient(options = {}) {
    const resolvedBase = textOr(options.baseURL, DEFAULT_BASE_URL).replace(/\/+$/, '');
    const modelName = textOr(options.model, DEFAULT_MODEL);
    const timeoutMs = positiveOr(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    const batchSize = integerOr(options.batchSize, DEFAULT_BATCH_SIZE);
    const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
    const url = resolvedBase + '/embeddings';

    /** 维度：请求前用默认值给空串造零向量；收到响应后以服务端实际维度为准。 */
    let knownDim = integerOr(options.dimension, DEFAULT_DIM);

    /**
     * 单批请求：整条流程（连接 + 响应头 + 读 body + 解析）都在同一个超时竞速里。
     *
     * 为什么不用「只 race fetch()」：fetch 拿到响应头就 resolve，body 仍可能卡住；
     * 把整个 flow 包进 race，任何阶段卡死都会在 timeoutMs 内变成 timeout 错误。
     * AbortController 只是顺手让真实网络请求早点收工（fake fetch 不理会 signal 也不影响判定）。
     */
    async function request(inputs) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const flow = requestFlow(inputs, controller);
        let timer = null;
        const timeout = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                controller?.abort();
                reject(new EmbeddingError(
                    'timeout',
                    '嵌入请求超时（' + timeoutMs + 'ms，' + inputs.length + ' 条）',
                ));
            }, timeoutMs);
        });
        try {
            return await Promise.race([flow, timeout]);
        } catch (error) {
            if (error instanceof EmbeddingError) throw error;
            // 网络层异常（DNS / 连接重置 / 证书）统一归到 http：对上层都是「这次拿不到」。
            throw new EmbeddingError('http', '嵌入请求失败：' + snippet(error?.message ?? '网络错误'));
        } finally {
            clearTimeout(timer);
        }
    }

    /** 一次 HTTP 往返：发请求 → 判状态码 → 解析 → 校验形状。 */
    async function requestFlow(inputs, controller) {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                // key 只出现在请求头；错误消息、日志一律不带它。
                authorization: 'Bearer ' + String(options.apiKey ?? '').trim(),
            },
            body: JSON.stringify({ model: modelName, input: inputs, encoding_format: 'float' }),
            signal: controller === null ? undefined : controller.signal,
        });

        const status = Number(response?.status ?? 0);
        const ok = typeof response?.ok === 'boolean' ? response.ok : status >= 200 && status < 300;
        if (!ok) {
            let body = '';
            try {
                body = typeof response?.text === 'function' ? await response.text() : '';
            } catch {
                // 错误响应读不到正文就只报状态码：诊断价值不抵一次额外的超时风险。
            }
            throw new EmbeddingError('http', '嵌入请求返回 HTTP ' + status + (body.trim() === '' ? '' : '：' + snippet(body)));
        }

        let payload;
        try {
            payload = typeof response?.json === 'function'
                ? await response.json()
                : JSON.parse(String(await response.text()));
        } catch {
            throw new EmbeddingError('malformed', '嵌入响应不是合法 JSON');
        }
        return parsePayload(payload, inputs.length);
    }

    /** 校验 OpenAI 兼容的 {data:[{embedding, index?}]} 形状，并按 index 归位。 */
    function parsePayload(payload, expected) {
        const rows = payload?.data;
        if (!Array.isArray(rows) || rows.length === 0) {
            throw new EmbeddingError('empty', '嵌入响应没有 data（key 失效或模型无权限时常见）');
        }
        if (rows.length !== expected) {
            throw new EmbeddingError('malformed', '嵌入条数不符：期望 ' + expected + '，实际 ' + rows.length);
        }

        const vectors = new Array(expected);
        for (let position = 0; position < rows.length; position += 1) {
            const row = rows[position];
            const values = row?.embedding;
            if (!Array.isArray(values) || values.length === 0) {
                throw new EmbeddingError('malformed', '嵌入响应第 ' + position + ' 条缺少 embedding 数组');
            }
            const vector = new Float32Array(values.length);
            for (let offset = 0; offset < values.length; offset += 1) {
                const value = Number(values[offset]);
                if (!Number.isFinite(value)) {
                    throw new EmbeddingError('malformed', '嵌入向量含非有限数值');
                }
                vector[offset] = value;
            }
            // 服务端可能按 index 回填（并行丢失顺序），有 index 就按 index 归位，否则按到达顺序。
            const target = Number.isInteger(row?.index) && row.index >= 0 && row.index < expected
                ? row.index
                : position;
            if (vectors[target] !== undefined) {
                throw new EmbeddingError('malformed', '嵌入响应下标重复（index 冲突）');
            }
            vectors[target] = vector;
        }
        for (const vector of vectors) {
            if (vector === undefined) throw new EmbeddingError('malformed', '嵌入响应缺少条目');
        }

        knownDim = vectors[0].length;
        return vectors;
    }

    /**
     * 把文本批量变成向量。
     *
     * 顺序保证：分批是**串行**的，空串原地填空零向量，返回数组与入参严格一一对应。
     * 为什么串行而不并发：免费额度下的并发只会换来 429，而 4 秒超时是按单请求算的，
     * 并发把超时预算摊薄反而更容易整轮失败。
     *
     * @param {string[]} texts
     * @returns {Promise<Float32Array[]>}
     */
    async function embed(texts) {
        if (!Array.isArray(texts)) throw new TypeError('embed(texts) 需要字符串数组');
        // 没 key 在第一次调用时抛：构造期不抛，宿主才能「无 key 也能启动并跑纯 BM25」。
        if (String(options.apiKey ?? '').trim() === '') {
            throw new EmbeddingError('no-key', '缺少 embedding API key（未配置 semanticApiKey）');
        }
        if (texts.length === 0) return [];
        if (typeof fetchImpl !== 'function') {
            throw new EmbeddingError('http', '当前运行环境没有可用的 fetch');
        }

        const output = new Array(texts.length);
        const pending = [];
        for (let index = 0; index < texts.length; index += 1) {
            const text = texts[index];
            if (typeof text !== 'string') {
                throw new TypeError('embed(texts) 第 ' + index + ' 项不是字符串');
            }
            if (text.trim() === '') {
                // 空串不占网络与配额：零向量与任何向量 cosine 都是 0，效果等同「不参与」。
                output[index] = new Float32Array(knownDim);
                continue;
            }
            pending.push({ index, text });
        }

        for (let start = 0; start < pending.length; start += batchSize) {
            const slice = pending.slice(start, start + batchSize);
            const vectors = await request(slice.map((item) => item.text));
            for (let offset = 0; offset < vectors.length; offset += 1) {
                output[slice[offset].index] = vectors[offset];
            }
        }
        return output;
    }

    return {
        embed,
        model: modelName,
        baseURL: resolvedBase,
        get dim() {
            return knownDim;
        },
    };
}

/**
 * float32 → IEEE 754 half（16 位），含就近舍入（round-to-nearest-even）。
 *
 * @param {number} value
 * @param {{ f32: Float32Array, u32: Uint32Array }} scratch 复用视图：每元素 new 一组视图太贵。
 * @returns {number} 16 位无符号整数
 */
function float32ToHalf(value, scratch) {
    scratch.f32[0] = value;
    const bits = scratch.u32[0];
    const sign = (bits >>> 16) & 0x8000;
    const exponent = ((bits >>> 23) & 0xff) - 112; // 127（f32 偏置）- 15（half 偏置）
    let mantissa = bits & 0x7fffff;

    // NaN / ±Inf
    if (exponent === 0x8f) {
        return sign | (mantissa === 0 ? 0x7c00 : 0x7e00);
    }
    if (exponent >= 0x1f) return sign | 0x7c00; // 上溢成 ±Inf
    if (exponent <= 0) {
        if (exponent < -10) return sign; // 小于 half 最小次正规数的一半：直接落 0
        // 次正规：把隐含位补回来，再右移到 half 的尾数宽度（含舍入）。
        mantissa |= 0x800000;
        const shift = 14 - exponent;
        let half = mantissa >>> shift;
        const remainder = mantissa & ((1 << shift) - 1);
        const halfway = 1 << (shift - 1);
        if (remainder > halfway || (remainder === halfway && (half & 1) === 1)) half += 1;
        return sign | half;
    }

    let half = (exponent << 10) | (mantissa >>> 13);
    const remainder = mantissa & 0x1fff;
    if (remainder > 0x1000 || (remainder === 0x1000 && (half & 1) === 1)) half += 1;
    return sign | half;
}

/**
 * IEEE 754 half → float32（用 double 算再落到 Float32Array，等价且没有位运算拼接错误）。
 *
 * @param {number} raw 16 位无符号整数
 * @returns {number}
 */
function halfToFloat32(raw) {
    const sign = (raw & 0x8000) === 0 ? 1 : -1;
    const exponent = (raw >>> 10) & 0x1f;
    const mantissa = raw & 0x3ff;
    if (exponent === 0) return sign * mantissa * 2 ** -24; // 次正规
    if (exponent === 0x1f) return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/**
 * 向量 → base64（float16，小端）。
 *
 * 为什么小端：编解码在同一个进程里，端序只是内部约定；固定小端是为了跨平台（x86/ARM）
 * 读写同一份缓存文件时不出现「换手机就全错位」。
 *
 * @param {Float32Array | number[]} vec
 * @returns {string}
 */
export function encodeVector(vec) {
    const source = vec instanceof Float32Array ? vec : Array.isArray(vec) ? Float32Array.from(vec) : null;
    if (source === null) throw new TypeError('encodeVector: 需要 Float32Array');
    const bytes = Buffer.alloc(source.length * 2);
    // 两个视图必须叠在**同一块** ArrayBuffer 上：写 f32 才能按位读到 u32（分开 new 就永远读到 0）。
    const buffer = new ArrayBuffer(4);
    const scratch = { f32: new Float32Array(buffer), u32: new Uint32Array(buffer) };
    for (let index = 0; index < source.length; index += 1) {
        const half = float32ToHalf(source[index], scratch);
        bytes[index * 2] = half & 0xff;
        bytes[index * 2 + 1] = (half >>> 8) & 0xff;
    }
    return bytes.toString('base64');
}

/**
 * base64 → 向量（float16 小端）。
 *
 * 长度不符直接抛：缓存是派生物，坏一条就重算一条，绝不能把错位的向量当相似度用。
 *
 * @param {string} text
 * @param {number} dim 期望维度（字节数 = dim × 2）
 * @returns {Float32Array}
 */
export function decodeVector(text, dim) {
    const size = integerOr(dim, 0);
    if (size <= 0) throw new TypeError('decodeVector: 需要正整数 dim');
    if (typeof text !== 'string' || text === '') throw new TypeError('decodeVector: 需要 base64 字符串');

    // Node 的 base64 解码对非法字符是宽容的（静默丢弃），所以以「字节数」为唯一判据。
    const bytes = Buffer.from(text, 'base64');
    if (bytes.length !== size * 2) {
        throw new RangeError('decodeVector: 期望 ' + size * 2 + ' 字节，实际 ' + bytes.length + ' 字节');
    }
    const vector = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
        vector[index] = halfToFloat32(bytes[index * 2] | (bytes[index * 2 + 1] << 8));
    }
    return vector;
}

/**
 * cosine 相似度。
 *
 * 边界一律归 0（而不是抛/NaN）：长度不等 = 不可比（模型换了或缓存脏），零向量 = 没有方向，
 * 两者在召回里都等于「这条线不成立」，返回 NaN 会污染排序与门槛比较。
 * 结果 clamp 到 [-1,1]：浮点累计误差偶尔给出 1.0000000000000002，会让测试与阈值抖动。
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
    if (!a || !b || typeof a.length !== 'number' || typeof b.length !== 'number') return 0;
    if (a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index += 1) {
        const left = a[index];
        const right = b[index];
        dot += left * right;
        normA += left * left;
        normB += right * right;
    }
    if (!(normA > 0) || !(normB > 0)) return 0;
    const value = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(-1, value));
}

/**
 * 存储层日志：宿主 logger 是 {info?, warn?}(string)。
 *
 * 为什么要分级别：「缓存文件还不存在」是首次启动的正常状态，用 warn 会让每一轮都刷一条
 * 噪声；只有真的坏 JSON / 版本不符 / 读失败才该 warn。测试里也可以直接传函数——
 * 函数形态只收 warn（想收 info 就传对象），这是测试替身的便利，不是宿主契约。
 */
function emit(log, level, message) {
    const sink = typeof log === 'function'
        ? (level === 'warn' ? log : undefined)
        : typeof log?.[level] === 'function' ? log[level] : undefined;
    if (typeof sink === 'function') sink('[persona-memory-recall] 向量缓存：' + message);
}

/**
 * 向量侧车缓存（JSON 文件 + 内存 Map）。
 *
 * 为什么用 JSON 而不是 sqlite / 向量库：整份缓存 1000 条约 2.7 MB，读一次即可全部进内存；
 * 逐条插入数据库在手机上反而更慢，还多一个依赖。缓存本身可丢可重建，最坏情况只是
 * 下一轮重新 embed。
 *
 * @param {{
 *   file: string,
 *   log?: { warn?: (message: string) => void } | ((message: string) => void),
 *   maxVectors?: number,
 *   model?: string,
 *   dim?: number,
 * }} options
 * @returns {{
 *   load: () => { ok: boolean, count: number, reason: string, skipped?: number, evicted?: number },
 *   get: (hash: string) => Float32Array | undefined,
 *   putMany: (entries: { hash: string, vec: Float32Array }[], opts?: { validHashes?: Set<string> | string[] }) => { added: number, pruned: number, kept: number, evicted: number },
 *   save: () => { bytes: number, count: number },
 *   clear: () => { cleared: number },
 *   file: string,
 *   model: string,
 *   dim: number,
 *   size: number,
 * }}
 */
export function createVectorStore(options = {}) {
    const file = typeof options.file === 'string' ? options.file : '';
    if (file.trim() === '') throw new TypeError('createVectorStore: 需要 file 路径');
    const log = options.log;
    const limit = integerOr(options.maxVectors, 5000);
    const modelName = textOr(options.model, DEFAULT_MODEL);
    const dimension = integerOr(options.dim, DEFAULT_DIM);

    /**
     * 为什么用 Map 而不是普通对象：Map 的插入顺序就是 LRU 顺序——put/get 时 delete+set
     * 把条目挪到队尾，淘汰时从队首取，O(1) 且不用额外维护时间戳数组。
     * @type {Map<string, Float32Array>}
     */
    const vectors = new Map();

    /** 超出上限时从队首淘汰（最近最少使用）。返回淘汰条数。 */
    function trim() {
        let evicted = 0;
        while (vectors.size > limit) {
            const oldest = vectors.keys().next().value;
            vectors.delete(oldest);
            evicted += 1;
        }
        return evicted;
    }

    /**
     * 从磁盘载入。
     *
     * 所有「文件不对」的情形都按空库处理并 warn，不抛：缓存坏了要能自愈（下一轮重建），
     * 抛错会把「语义不可用」升级成「召回失败」。
     */
    function load() {
        vectors.clear();
        let raw;
        try {
            raw = readFileSync(file, 'utf8');
        } catch (error) {
            if (error?.code === 'ENOENT') {
                // 首次启动的正常状态：用 info，不占用 warn（否则每轮都有一条噪声）。
                emit(log, 'info', '缓存文件不存在，按空库启动（首轮会在后台重建）：' + file);
                return { ok: true, count: 0, reason: 'missing' };
            }
            emit(log, 'warn', '读取失败，按空库启动：' + String(error?.message ?? error));
            return { ok: false, count: 0, reason: 'read-error' };
        }

        let payload;
        try {
            payload = JSON.parse(raw);
        } catch {
            emit(log, 'warn', '坏 JSON，整份丢弃重建：' + file);
            return { ok: false, count: 0, reason: 'bad-json' };
        }
        if (payload === null || typeof payload !== 'object' || payload.v !== CACHE_VERSION) {
            emit(log, 'warn', '结构版本不符（期望 ' + CACHE_VERSION + '，实际 ' + String(payload?.v) + '），整份丢弃重建');
            return { ok: false, count: 0, reason: 'version' };
        }
        // 模型/维度不符 = 向量不在同一个空间里，比「没有缓存」更糟：必须整份丢弃。
        if (typeof payload.model === 'string' && payload.model !== modelName) {
            emit(log, 'warn', '模型不符（缓存 ' + payload.model + '，当前 ' + modelName + '），整份丢弃重建');
            return { ok: false, count: 0, reason: 'model' };
        }
        if (Number.isInteger(payload.dim) && payload.dim !== dimension) {
            emit(log, 'warn', '维度不符（缓存 ' + payload.dim + '，当前 ' + dimension + '），整份丢弃重建');
            return { ok: false, count: 0, reason: 'dim' };
        }
        const rows = payload.vectors;
        if (rows === null || typeof rows !== 'object') {
            emit(log, 'warn', '缺少 vectors 字段，整份丢弃重建');
            return { ok: false, count: 0, reason: 'shape' };
        }

        let skipped = 0;
        for (const [hash, encoded] of Object.entries(rows)) {
            if (typeof encoded !== 'string' || hash === '') {
                skipped += 1;
                continue;
            }
            try {
                vectors.set(hash, decodeVector(encoded, dimension));
            } catch {
                skipped += 1; // 单条坏就丢单条：其余向量仍然有效，没必要整份重建。
            }
        }
        if (skipped > 0) emit(log, 'warn', '有 ' + skipped + ' 条无法解码，已跳过');
        const evicted = trim();
        if (evicted > 0) emit(log, 'warn', '超过上限 ' + limit + '，载入时淘汰 ' + evicted + ' 条');
        return { ok: true, count: vectors.size, reason: 'ok', skipped, evicted };
    }

    /** 取向量；命中即刷新 LRU 顺序（下一轮查到的条目不该先被淘汰）。 */
    function get(hash) {
        if (typeof hash !== 'string' || hash === '') return undefined;
        const vector = vectors.get(hash);
        if (vector === undefined) return undefined;
        vectors.delete(hash);
        vectors.set(hash, vector);
        return vector;
    }

    /**
     * 批量写入，可选按 validHashes 剪枝。
     *
     * 为什么要 validHashes：chunk 重建后（日志增长、压缩重建索引）同一段正文的 hash 会变，
     * 旧 hash 的向量永远查不到，只是白占文件和内存。调用方把「本轮仍在池里的 hash」传进来，
     * 不在集合里的旧向量一次剪掉，缓存就跟着 chunk 自动收敛。
     *
     * @param {{ hash: string, vec: Float32Array | number[] }[]} entries
     * @param {{ validHashes?: Set<string> | string[] }} [opts]
     * @returns {{ added: number, pruned: number, kept: number, evicted: number }} added=本次写入条数（含覆盖同 hash），kept=操作后库存条数。
     */
    function putMany(entries, opts = {}) {
        const validHashes = opts?.validHashes;
        let pruned = 0;
        if (validHashes instanceof Set || Array.isArray(validHashes)) {
            const valid = validHashes instanceof Set ? validHashes : new Set(validHashes);
            for (const hash of [...vectors.keys()]) {
                if (!valid.has(hash)) {
                    vectors.delete(hash);
                    pruned += 1;
                }
            }
        }

        let added = 0;
        let skipped = 0;
        for (const entry of Array.isArray(entries) ? entries : []) {
            const hash = typeof entry?.hash === 'string' ? entry.hash : '';
            const vector = entry?.vec instanceof Float32Array
                ? entry.vec
                : Array.isArray(entry?.vec) ? Float32Array.from(entry.vec) : null;
            if (hash === '' || vector === null || vector.length !== dimension) {
                skipped += 1;
                continue;
            }
            // 覆盖同 hash 时先删再插：否则旧条目的 LRU 位置会留在队首，刚更新的反而先被淘汰。
            vectors.delete(hash);
            vectors.set(hash, vector);
            added += 1;
        }
        if (skipped > 0) {
            emit(log, 'warn', '有 ' + skipped + ' 条向量不可用（hash 为空或维度不是 ' + dimension + '），已跳过');
        }
        const evicted = trim();
        return { added, pruned, kept: vectors.size, evicted };
    }

    /**
     * 原子落盘：同目录临时文件 + rename。
     *
     * 为什么不能直接 writeFileSync：手机进程随时可能被杀（省电、切后台），写到一半就是
     * 一份坏 JSON——虽然 load 能容错重建，但每次重建都要重新 embed 上千条，代价是真实配额。
     * rename 在同一文件系统上原子，读到的永远是完整的旧版或新版。
     *
     * @returns {{ bytes: number, count: number }}
     */
    function save() {
        const rows = {};
        for (const [hash, vector] of vectors) rows[hash] = encodeVector(vector);
        // 不 pretty-print：一条 2.7 KB，缩进会让文件体积翻倍（1000 条就多 1 MB+）。
        const text = JSON.stringify({ v: CACHE_VERSION, model: modelName, dim: dimension, vectors: rows });
        mkdirSync(dirname(file), { recursive: true });
        const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
        try {
            writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
            renameSync(tmp, file);
        } catch (error) {
            // 清残留临时文件：下一次写会换新名字，残留只会累积。
            try {
                rmSync(tmp, { force: true });
            } catch {
                // 清不掉也不影响本次报错
            }
            throw error;
        }
        return { bytes: Buffer.byteLength(text, 'utf8'), count: vectors.size };
    }

    /** 清空内存（不删文件）；调用方决定是否 save() 把空库写回去。 */
    function clear() {
        const cleared = vectors.size;
        vectors.clear();
        return { cleared };
    }

    return {
        load,
        get,
        putMany,
        save,
        clear,
        file,
        model: modelName,
        dim: dimension,
        get size() {
            return vectors.size;
        },
    };
}
