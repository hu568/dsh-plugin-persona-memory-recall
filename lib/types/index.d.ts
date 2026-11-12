/**
 * 宿主半的类型声明。运行时是纯 JavaScript（ESM），这里只给编辑器/调用方看。
 */

import type { Context } from 'cordis';

export declare const name: string;
export declare const SOURCE_KIND: string;
export declare const SECTION_NAME: string;
export declare const REHYDRATE_SECTION_NAME: string;

export interface RecallConfig {
    enabled: boolean;
    journalPath: string;
    topK: number;
    /** 旧键：整轮字符预算（0 = 用 maxTotalChars）。 */
    maxChars: number;
    /** 整轮总字符预算：前言 + 标签 + 正文（0 = 沿用 maxChars）。 */
    maxTotalChars: number;
    /** 旧键：单段截断长度（0 = 用 maxEntryChars）。 */
    perChunkChars: number;
    /** 单条上限：标签 + 正文 + 截断后缀（0 = 沿用 perChunkChars）。 */
    maxEntryChars: number;
    /** 剩余预算不足这么多字符就整条丢弃，不写半条。 */
    minEntryChars: number;
    chunkChars: number;
    maxChunksPerEntry: number;
    scanEntries: number;
    minScore: number;
    relativeCut: number;
    recencyHalfLifeDays: number;
    recencyWeight: number;
    minQueryTokens: number;
    minTurnsBetween: number;
    subagent: boolean;
    dedupeAgainstMemory: boolean;
    /** 与记忆文件的去重阈值（行级 2-gram Dice）；0 = 关掉 Dice。 */
    dedupeDiceThreshold: number;
    /** 去重只比对这么长以上的行。 */
    dedupeMinLineChars: number;
    /** 按工作区隔离召回（JOURNAL 行 cwd / workspaceId；无字段的旧行放行）。 */
    workspaceIsolation: boolean;
    /** 命中词少于这个数时走覆盖率判定；0 = 关掉命中门槛。 */
    minMatchedTokens: number;
    /** 单命中时的覆盖率门槛（罕见命中词 / 索引内存在的查询词数）；0 = 关。 */
    minCoverage: number;
    /** 单命中豁免的罕见度上限：命中词 df/N ≤ 该值才算罕见证据。 */
    singleMatchMaxDfRatio: number;
    /** topK 分档：最高分达到 minScore 的几倍才给满 5 条。 */
    tierFullRatio: number;
    /** topK 分档：最高分达到 minScore 的几倍才给 4 条。 */
    tierHighRatio: number;
    /** topK 分档：最高分达到 minScore 的几倍才给 3 条。 */
    tierMidRatio: number;
    /** 跨轮去重：同一片段注入过就不再注入（压缩成功时清空）。 */
    dedupeAcrossTurns: boolean;
    maxQueryChars: number;
    debug: boolean;
    /** 压缩后是否把「本会话最近 N 条日志」重建注入一次。 */
    rehydrate: boolean;
    /** 重建包最多回放多少条日志。 */
    maxRehydrateEntries: number;
    /** 重建包的总字符上限。 */
    maxRehydrateChars: number;

    /* ── 语义召回（RAG，0.6.0）：默认开；没有 key 时自动退回纯 BM25 ───────── */

    /** 语义通道总开关；没配 key 时不生效。 */
    semantic: boolean;
    /** 嵌入模型名（默认 BAAI/bge-m3）。 */
    semanticModel: string;
    /** 嵌入服务 base URL（不含 /embeddings）。 */
    semanticBaseURL: string;
    /** 空则按 config > $DSH_HOME/memory/recall-rag.json > env SILICONFLOW_API_KEY 解析。 */
    semanticApiKey: string;
    /** cosine 相似度门槛（0–1）。 */
    semanticMinSimilarity: number;
    /** 单轮语义查询超时（毫秒）；超时降级纯 BM25。 */
    semanticTimeoutMs: number;
    /** 查询短于此字符数不 embed。 */
    semanticMinQueryChars: number;
    /** 向量缓存路径；空 = $DSH_HOME/memory/recall/embeddings.json。 */
    semanticCachePath: string;
    /** 每轮后台最多补多少条向量。 */
    semanticWarmupBatch: number;
}

export interface JournalEntry {
    ts: string;
    tags: string[];
    text: string;
    /** 写入侧落盘的归属字段（跨包契约）；缺字段表示未知归属，读侧 fail-open。 */
    cwd?: string;
    workspaceId?: string;
}

export interface JournalChunk {
    entry: JournalEntry;
    text: string;
    /** 原始片段正文的指纹（跨轮去重用）。 */
    hash?: string;
}

export interface JournalSnapshot {
    file: string;
    bytes: number;
    total: number;
    entries: JournalEntry[];
    chunks: JournalChunk[];
    index: unknown;
    builtAt: number;
}

/** 召回层拿到的语义入参（0.6.0）：只读向量集 + 查询向量 + 门槛覆盖。 */
export interface RecallSemanticOptions {
    /** 片段指纹 → 向量（只读视图，只调用 get）。 */
    vectors: { get(hash: string): Float32Array | undefined };
    /** 本轮查询向量；null = 语义不可用，退回纯 BM25。 */
    queryVec: Float32Array | null;
    /** cosine 门槛，默认 0.55。 */
    minSimilarity?: number;
    /** 相对切，默认 0.5（相似度还要 ≥ 本轮最高相似度 × 该比例）。 */
    relativeCut?: number;
    /** RRF 权重，默认 bm25=1 / semantic=1。 */
    weights?: { bm25: number; semantic: number };
}

export interface RecallHit {
    ts: string;
    tags: string[];
    text: string;
    /** 纯 BM25 时是 BM25 分；语义通道里是融合分（RRF）。 */
    score: number;
    /** 原始片段正文的指纹（写进会话已注入集合用）。 */
    hash: string;
    /** 语义通道才出现：池内 cosine 相似度（无向量时缺省）。 */
    similarity?: number;
    /** 语义通道才出现：融合前的 BM25 分（语义专属命中为 0）。 */
    bm25Score?: number;
}

export interface RecallFilterStats {
    workspace: number;
    injected: number;
    gate: number;
    duplicate: number;
}

/** 语义通道统计（纯 BM25 输出不带这个字段）。 */
export interface RecallSemanticReport {
    used: boolean;
    /** 过相似度绝对门槛 + 相对切的候选数。 */
    candidates: number;
    /** 语义候选里没进最终 hits 的条数（topK/预算/去重挡掉）。 */
    gated: number;
    /** 本轮池内最高相似度。 */
    topSimilarity: number;
}

export interface RecallResult {
    text: string | null;
    hits: RecallHit[];
    reason:
        | 'ok'
        | 'short-query'
        | 'empty-journal'
        | 'no-hit'
        | 'below-min-score'
        | 'filtered'
        | 'budget-too-small';
    /** 正文行占用（含每行换行），不含前言。 */
    usedChars: number;
    /** 整份注入文本的实际长度（前言 + 标签 + 正文）。 */
    totalChars: number;
    /** 本次生效的三档预算。 */
    budget: { total: number; entry: number; min: number };
    /** 按最高分分档后的实际 topK。 */
    effectiveTopK: number;
    /** 本轮最高 BM25 分（含时效加成）；纯语义命中时可能为 0。 */
    topScore: number;
    /** 查询 token 数（去重前）。 */
    queryTokens: number;
    /** 各类过滤计数，用来解释「为什么一条都没发」。 */
    filtered: RecallFilterStats;
    /** 命中门槛的实际计算值。 */
    gate: { coverage: number; rareMatched: number; existing: number };
    /** 语义通道统计；只有真正拿到 query 向量时出现。 */
    semantic?: RecallSemanticReport;
}

export interface JournalStore {
    readonly path: string;
    configure(patch: {
        scanEntries?: number;
        chunkChars?: number;
        maxChunksPerEntry?: number;
    }): JournalStore;
    snapshot(): JournalSnapshot;
}

/** 设置页支持的控件（本插件只用到这几种）。 */
export type RecallSettingKind = 'toggle' | 'text' | 'readonly';

/** 注册到父插件「记忆」设置页的一项。 */
export interface RecallSettingItem {
    id: string;
    group: string;
    title: string;
    description: string;
    kind: RecallSettingKind;
    order: number;
    value: boolean | string | number;
    onChange?(value: boolean | string | number): void | Promise<void>;
}

/** 覆盖层路径：$DSH_HOME/memory/recall.json。 */
export declare function recallOverridesPath(): string;

/** 语义 key 侧车路径：$DSH_HOME/memory/recall-rag.json。 */
export declare function ragConfigPath(): string;

/** 语义 key 侧车内容（敏感：只读进内存，绝不写日志/仓库）。 */
export interface RagConfig {
    apiKey?: string;
    model?: string;
    baseURL?: string;
}

/** 读语义 key 侧车；不存在/坏 JSON 返回空对象（不抛）。 */
export declare function readRagConfig(file?: string): RagConfig;

/** 原子写语义 key 侧车（同目录 tmp + rename，落盘 chmod 600）。 */
export declare function writeRagConfig(
    next: RagConfig,
    file?: string,
): { bytes: number; path: string };

/** 语义 API Key 优先级：config > recall-rag.json > env SILICONFLOW_API_KEY。 */
export declare function resolveSemanticApiKey(config?: Partial<RecallConfig>, file?: string): string;

/** 设置页能改的键及其校验规则。 */
export declare const SETTINGS_SPECS: ReadonlyArray<{
    key: keyof RecallConfig;
    kind: 'toggle' | 'text';
    group?: string;
    title: string;
    description: string;
    /** 字符串项（模型名 / API Key）：不做数字校验。 */
    valueType?: 'string';
    /** 只写语义侧车、不进 recall.json（目前只有 API Key）。 */
    ragOnly?: boolean;
    /** 页面永不回显（API Key）。 */
    secret?: boolean;
    min?: number;
    max?: number;
    integer?: boolean;
    order: number;
}>;

/** 语义召回设置分组名。 */
export declare const SETTINGS_SEMANTIC_GROUP: string;

/** 把页面原始值转成合法值；不合法抛错。 */
export declare function coerceSetting(key: string, raw: unknown): boolean | number | string;

/** 读覆盖层；坏文件/坏值都当作没设过。 */
export declare function readRecallOverrides(file?: string): Partial<RecallConfig>;

/** 原子写入覆盖层。 */
export declare function writeRecallOverrides(overrides: Partial<RecallConfig>, file?: string): void;

/** 把覆盖层原地合并进运行时 config。 */
export declare function applyRecallOverrides(
    config: RecallConfig,
    overrides: Partial<RecallConfig>,
): RecallConfig;

/** 造设置项（id 形如 recall.<key>）。 */
export declare function createSettingItems(options: {
    config: RecallConfig;
    journalPath: string;
    onChange: (key: string, raw: unknown) => void | Promise<void>;
}): RecallSettingItem[];

export declare const Config: unknown;

export declare function isSubagent(session: unknown): boolean;

/** 本轮消息里最后一条真人用户消息的下标（没有 = -1）。 */
export declare function lastUserIndex(messages: unknown[] | undefined): number;

export declare function turnUserText(
    session: unknown,
    turn: number,
    proposed: unknown[] | undefined,
    maxChars?: number,
): string;

/** 召回选择与渲染（纯函数，测试/诊断可直接调）。 */
export declare function recall(options: {
    snapshot: JournalSnapshot;
    query: string;
    config: RecallConfig;
    memoryTexts?: string[];
    /** 会话 cwd：工作区隔离依据。 */
    cwd?: string;
    /** 本会话已注入片段指纹（跨轮去重）。 */
    skipChunkHashes?: Set<string> | string[];
    now?: number;
    /** 语义通道入参；不传 / queryVec=null → 与 0.5.0 逐字节一致的纯 BM25。 */
    semantic?: RecallSemanticOptions;
}): RecallResult;

export declare function resolveBudget(config?: Partial<RecallConfig>): {
    total: number;
    entry: number;
    min: number;
};

/** 预算是否装得下「壳 + 最小一条」。 */
export declare function budgetViability(config?: Partial<RecallConfig>): {
    ok: boolean;
    total: number;
    shell: number;
    min: number;
    minRequired: number;
};

/** 渲染召回块（前言三重条款在这里）。 */
export declare function renderHits(lines: string[], count: number): string;

/** 截断引流后缀。 */
export declare const TRUNC_SUFFIX: string;

/** 片头截断（重建包复用）。 */
export declare function clipToLimit(text: string, limit: number): string;

/** 从首个命中词开窗截断。 */
export declare function clipAroundHit(text: string, limit: number, needles?: string[]): string;

/** 按最高分给 topK 分档（5/4/3/1，且不超过用户 topK）。 */
export declare function effectiveTopK(config: Partial<RecallConfig>, topScore: number): number;

/** 按 hitStrength 的强度比值给 topK 分档（语义通道用；奇偶与 effectiveTopK 同口径）。 */
export declare function effectiveTopKByStrength(config: Partial<RecallConfig>, ratio: number): number;

/** 命中门槛判定。 */
export declare function hitGate(
    config: Partial<RecallConfig>,
    item: { matched: string[]; docLen: number; queryExisting?: number },
    queryTokenCount: number,
    index: { df: Map<string, number>; N: number } | undefined,
): { ok: boolean; coverage: number; rareMatched: number; existing: number };

/** 默认向量缓存路径：$DSH_HOME/memory/recall/embeddings.json。 */
export declare function defaultEmbeddingsPath(): string;

/** 带超时跑一次语义查询；任何失败返回 undefined（调用方退回纯 BM25）。 */
export declare function querySemanticWithTimeout(
    index: { query(text: string): Promise<any> } | undefined | null,
    query: string,
    timeoutMs: number,
): Promise<{
    queryVec: Float32Array;
    vectors: { get(hash: string): Float32Array | undefined };
} | undefined>;

/** 语义运行时（嵌入客户端 + 向量缓存 + 查询/补齐接口）。 */
export interface SemanticRuntime {
    index: {
        query(text: string): Promise<{
            queryVec: Float32Array | null;
            vectors: { get(hash: string): Float32Array | undefined };
        }>;
        ensure(chunks: JournalChunk[]): Promise<{ added: number; pruned?: number; kept?: number } | undefined>;
        readonly file: string;
        readonly size: number;
    };
    client: unknown;
    store: unknown;
    file: string;
    model: string;
    baseURL: string;
}

/** 建语义运行时；没 key 或总开关关闭返回 undefined（纯 BM25）。 */
export declare function createSemanticRuntime(options: {
    config: RecallConfig;
    logger?: { info?(message: string): void; warn?(message: string): void };
    cacheFile: string;
}): SemanticRuntime | undefined;

export declare function createPreStepListener(options: {
    config: RecallConfig;
    store: JournalStore;
    memoryTextsFor: (session: unknown) => string[];
    logger?: { info?(message: string): void; warn?(message: string): void };
    /** 语义查询/补齐接口：对象或 getter（设置页重建运行时后要拿到新实例）。 */
    semanticIndex?: any | (() => any);
    watch?: {
        isPending(sessionId: string): boolean;
        marker?(sessionId: string): { compactedAt: number } | undefined;
        clear?(sessionId: string): boolean;
    };
}): {
    listener: (payload: unknown, next: () => unknown) => Promise<unknown>;
    states: Map<string, {
        turn?: number;
        queryKey: string;
        lastInjectedTurn?: number;
        /** 本会话已注入片段指纹。 */
        injected: Set<string>;
        /** 上一次没注入的原因。 */
        lastSkipReason: string;
        /** 预算不足告警是否已发过。 */
        budgetWarned: boolean;
    }>;
    dispose(): void;
};

/** session 事件分发：压缩成功后清标记与跨轮去重集合。 */
export declare function handleSessionEvent(
    bound: { states: Map<string, any> },
    watch: { handleEvent(session: unknown, event: unknown): boolean },
    session: unknown,
    event: unknown,
): boolean;

export declare function createJournalStore(options: {
    file: string;
    scanEntries: number;
    chunkChars: number;
    maxChunksPerEntry: number;
}): JournalStore;

export declare function apply(ctx: Context, config?: Partial<RecallConfig>): void;
