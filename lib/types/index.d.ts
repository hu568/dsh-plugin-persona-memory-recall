/**
 * 宿主半的类型声明。运行时是纯 JavaScript（ESM），这里只给编辑器/调用方看。
 */

import type { Context } from 'cordis';

export declare const name: string;
export declare const SOURCE_KIND: string;
export declare const SECTION_NAME: string;

export interface RecallConfig {
    enabled: boolean;
    journalPath: string;
    topK: number;
    maxChars: number;
    perChunkChars: number;
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
    reason: 'ok' | 'short-query' | 'empty-journal' | 'no-hit' | 'below-min-score' | 'filtered';
    usedChars: number;
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
