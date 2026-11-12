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

export interface RecallHit {
    ts: string;
    tags: string[];
    text: string;
    score: number;
    /** 原始片段正文的指纹（写进会话已注入集合用）。 */
    hash: string;
}

export interface RecallFilterStats {
    workspace: number;
    injected: number;
    gate: number;
    duplicate: number;
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
    /** 本轮最高 BM25 分（含时效加成）。 */
    topScore: number;
    /** 查询 token 数（去重前）。 */
    queryTokens: number;
    /** 各类过滤计数，用来解释「为什么一条都没发」。 */
    filtered: RecallFilterStats;
    /** 命中门槛的实际计算值。 */
    gate: { coverage: number; rareMatched: number; existing: number };
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

/** 设置页支持的三类控件（本插件只用到这三种）。 */
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

/** 设置页能改的键及其校验规则。 */
export declare const SETTINGS_SPECS: ReadonlyArray<{
    key: keyof RecallConfig;
    kind: 'toggle' | 'text';
    group?: string;
    title: string;
    description: string;
    min?: number;
    max?: number;
    integer?: boolean;
    order: number;
}>;

/** 把页面原始值转成合法值；不合法抛错。 */
export declare function coerceSetting(key: string, raw: unknown): boolean | number;

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

/** 命中门槛判定。 */
export declare function hitGate(
    config: Partial<RecallConfig>,
    item: { matched: string[]; docLen: number; queryExisting?: number },
    queryTokenCount: number,
    index: { df: Map<string, number>; N: number } | undefined,
): { ok: boolean; coverage: number; rareMatched: number; existing: number };

export declare function createPreStepListener(options: {
    config: RecallConfig;
    store: JournalStore;
    memoryTextsFor: (session: unknown) => string[];
    logger?: { info?(message: string): void; warn?(message: string): void };
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
