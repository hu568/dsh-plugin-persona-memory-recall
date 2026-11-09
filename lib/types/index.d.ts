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
}

export interface JournalChunk {
    entry: JournalEntry;
    text: string;
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

/** 覆盖层路径：`$DSH_HOME/memory/recall.json`。 */
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

/** 造设置项（id 形如 `recall.<key>`）。 */
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

export declare function createPreStepListener(options: {
    config: RecallConfig;
    store: JournalStore;
    memoryTextsFor: (session: unknown) => string[];
    logger?: { info?(message: string): void; warn?(message: string): void };
}): {
    listener: (payload: unknown, next: () => unknown) => Promise<unknown>;
    states: Map<string, { turn?: number; queryKey: string; lastInjectedTurn?: number }>;
    dispose(): void;
};

export declare function createJournalStore(options: {
    file: string;
    scanEntries: number;
    chunkChars: number;
    maxChunksPerEntry: number;
}): JournalStore;

export declare function apply(ctx: Context, config?: Partial<RecallConfig>): void;
