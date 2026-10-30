/**
 * @dsh-external/dsh-persona-memory-recall — 宿主机半（HOST PLANE）。
 *
 * 父插件 `@dsh-external/dsh-persona-memory` 的 JOURNAL.jsonl 只写不召回；
 * 本插件补上自动召回：**每轮用户消息**到达时，用这条消息当查询，对日志尾部做
 * BM25 检索，把命中片段作为一条 `user/message` 追加到本轮用户消息之后。
 *
 * 为什么是 pre-step 追加消息，而不是注册系统提示词段落：
 *  1. 段落位于提示词最前面，每轮改一次就从那一点开始击穿 KV 缓存前缀；
 *     追加消息只在本轮尾部新增内容，既有前缀完全不动。
 *  2. 宿主的 `@deepseek-ai/dsh-time-context` 就是这个合同：
 *     「Each injection is one additional user-role message in the durable history」
 *     「Append-only; newly visible content follows the reusable request prefix」。
 *  3. 消息带 `source.form = 'snapshot'`，客户端按上下文渲染，不会冒充用户原话。
 *
 * 代价（宿主自己也承认）：注入的消息会累积到下一次 compaction 才被遮掉。
 * 因此这里做四件事把代价压住：
 *  - 同一轮同一查询只注入一次（工具循环不重复）；
 *  - 没有命中、分数不够、与 FACT.md/项目 MEMORY.md 重复 → 一条都不发；
 *  - 命中的行有字符预算（默认 600 字符 ≈ 190 tok）；
 *  - 子代理默认不注入。
 *
 * 所有失败都被吞掉并记一行 warn：召回是锦上添花，绝不能炸掉 turn。
 */

import { createHash, randomUUID } from 'node:crypto';
import z from 'schemastery';
import { createJournalStore, defaultJournalPath } from './journal.js';
import { readMemoryTexts } from './memory.js';
import { recall } from './recall.js';
import {
    applyRecallOverrides,
    coerceSetting,
    createSettingItems,
    readRecallOverrides,
    writeRecallOverrides,
} from './settings.js';

/** Cordis 插件名（loader 诊断用）。 */
export const name = '@dsh-external/dsh-persona-memory-recall';

/** 注入消息的来源标记：唯一，且能被会话日志稳定识别。 */
export const SOURCE_KIND = 'persona-memory-recall';
/** 快照里的段落名，与父插件的 `memory:*` 前缀保持同一族。 */
export const SECTION_NAME = 'memory:recall';

/** 日志仓库对外导出，方便测试与外部诊断脚本复用同一份缓存语义。 */
export { createJournalStore } from './journal.js';

export const Config = z.object({
    enabled: z.boolean().default(true),
    /** 日志路径；空串 = `$DSH_HOME/memory/JOURNAL.jsonl`。 */
    journalPath: z.string().default(''),
    /** 最多注入几段。 */
    topK: z.number().min(1).default(5),
    /** 本轮注入的总字符预算（只算命中行，不含标签与提示语）。 */
    maxChars: z.number().min(80).default(600),
    /** 单段渲染时的截断长度。 */
    perChunkChars: z.number().min(40).default(240),
    /** 建索引时单段的目标长度。 */
    chunkChars: z.number().min(80).default(300),
    /** 每条日志最多切几段。 */
    maxChunksPerEntry: z.number().min(1).default(12),
    /** 只索引日志尾部 N 条。 */
    scanEntries: z.number().min(1).default(500),
    /** 绝对分数门槛（BM25 分，非归一化）。 */
    minScore: z.number().min(0).default(1.0),
    /** 低于「最高分 × 该比例」的命中丢掉。 */
    relativeCut: z.number().min(0).max(1).default(0.35),
    /** 时间衰减半衰期（天）；0 = 关闭。 */
    recencyHalfLifeDays: z.number().min(0).default(30),
    /** 时间衰减最大加成比例。 */
    recencyWeight: z.number().min(0).default(0.15),
    /** 查询 token 少于此数不召回。 */
    minQueryTokens: z.number().min(1).default(2),
    /** 两次注入之间至少间隔几轮（0 = 只要换查询就注）。 */
    minTurnsBetween: z.number().min(0).default(0),
    /** 子代理会话是否也注入。 */
    subagent: z.boolean().default(false),
    /** 与 FACT.md / 项目 MEMORY.md 去重。 */
    dedupeAgainstMemory: z.boolean().default(true),
    /** 查询只取用户消息的末尾这么多字符（防超长粘贴）。 */
    maxQueryChars: z.number().min(16).default(1500),
    /** 把每次注入/跳过的原因写进宿主日志。 */
    debug: z.boolean().default(false),
});

/**
 * 判定会话是不是委派出去的子代理：与父插件同口径（origin 优先，血缘兜底）。
 * @param {any} session
 * @returns {boolean}
 */
export function isSubagent(session) {
    const header = session?.header;
    if (header === undefined || header === null) return false;
    if (header.origin === 'subagent') return true;
    if (typeof header.parentSession === 'string' && header.parentSession !== '') return true;
    return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
}

function sessionEvents(session) {
    if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents();
    return Array.isArray(session?.events) ? session.events : [];
}

/** 取一条消息的纯文本（只认 text 块；图片/附件忽略）。 */
function textOf(message) {
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return '';
    const parts = [];
    for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n').trim();
}

/** 只认真人/外部输入：runtime-context、schedule、goal、team、approval 等一律不算查询。 */
function isUserSourced(message) {
    return message !== null && typeof message === 'object' && message.source?.kind === 'user';
}

/**
 * 本轮的用户查询：本次 pre-step 提出的消息 + 本 turn 内在历史里的用户消息。
 *
 * step > 1（工具循环）时 `proposed` 通常是空的，要靠历史回溯；
 * 回溯到 `turn/start` 就停，不会把上一轮的消息算进来。
 *
 * @param {any} session
 * @param {number} turn
 * @param {any[] | undefined} proposed `decision.messages`
 * @param {number} [maxChars]
 * @returns {string}
 */
export function turnUserText(session, turn, proposed, maxChars = 1500) {
    const parts = [];
    if (Array.isArray(proposed)) {
        for (const message of proposed) {
            if (isUserSourced(message)) parts.push(textOf(message));
        }
    }

    const events = sessionEvents(session);
    const older = [];
    for (let position = events.length - 1; position >= 0; position -= 1) {
        const event = events[position];
        if (event?.type === 'turn/start' && event.data?.turn === turn) break;
        if (event?.type !== 'user/message') continue;
        const message = event.data?.message ?? event.data;
        if (isUserSourced(message)) older.unshift(textOf(message));
    }

    const text = [...older, ...parts].filter((part) => part !== '').join('\n').trim();
    return text.length > maxChars ? text.slice(-maxChars) : text;
}

function hashQuery(text) {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** 造一条快照式 user 消息（与宿主 `createUserMessage` 同形，但不依赖宿主包）。 */
function createRecallMessage(text) {
    return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
            kind: SOURCE_KIND,
            form: 'snapshot',
            sections: [{ name: SECTION_NAME, text }],
        },
    };
}

/**
 * 造 pre-step 监听器（独立导出，方便纯 node 测试）。
 *
 * @param {{
 *   config: any,
 *   store: { snapshot(): any },
 *   memoryTextsFor: (session: any) => string[],
 *   logger?: { info?(message: string): void, warn?(message: string): void },
 * }} options
 * @returns {{ listener: (payload: any, next: () => any) => Promise<any>, states: Map<string, any>, dispose(): void }}
 */
export function createPreStepListener(options) {
    const { config, store, memoryTextsFor, logger } = options;
    /** sessionId → { turn, queryKey, lastInjectedTurn } */
    const states = new Map();

    const debug = (message) => {
        if (config.debug) logger?.info?.(`[persona-memory-recall] ${message}`);
    };

    const listener = async (payload, next) => {
        const decision = await next();
        try {
            if (decision === null || typeof decision !== 'object') return decision;
            if (decision.kind === 'reject') return decision;
            if (!config.enabled) return decision;
            if (payload?.signal?.aborted) return decision;

            const agent = payload?.agent;
            const session = agent?.session;
            if (agent === undefined || session === undefined) return decision;
            if (!config.subagent && isSubagent(session)) {
                debug('skip: subagent');
                return decision;
            }

            const turn = payload.turn;
            const query = turnUserText(session, turn, decision.messages, config.maxQueryChars);
            if (query === '') return decision;

            const sessionId = typeof agent.id === 'string' && agent.id !== '' ? agent.id : String(session.id ?? '');
            if (sessionId === '') return decision;

            let state = states.get(sessionId);
            if (state === undefined) {
                state = { turn: undefined, queryKey: '', lastInjectedTurn: undefined };
                states.set(sessionId, state);
            }

            // 同一轮同一查询只处理一次：工具循环里的 step 2..N 不再重复检索。
            const queryKey = hashQuery(query);
            if (state.turn === turn && state.queryKey === queryKey) return decision;
            state.turn = turn;
            state.queryKey = queryKey;

            if (
                config.minTurnsBetween > 0
                && typeof turn === 'number'
                && typeof state.lastInjectedTurn === 'number'
                && turn - state.lastInjectedTurn < config.minTurnsBetween
            ) {
                debug(`skip: minTurnsBetween (turn ${turn}, last ${state.lastInjectedTurn})`);
                return decision;
            }

            const memoryTexts = config.dedupeAgainstMemory ? memoryTextsFor(session) : [];
            const result = recall({
                snapshot: store.snapshot(),
                query,
                config,
                memoryTexts,
            });

            if (result.text === null) {
                debug(`skip: ${result.reason} (turn ${turn})`);
                return decision;
            }

            state.lastInjectedTurn = turn;
            debug(`inject: ${result.hits.length} hit(s), ${result.usedChars} chars (turn ${turn})`);

            return {
                ...decision,
                messages: [...(decision.messages ?? []), createRecallMessage(result.text)],
            };
        } catch (error) {
            // 召回失败只降级为「这轮不召回」，绝不让 turn 失败。
            logger?.warn?.(`[persona-memory-recall] 召回失败（已忽略）: ${String(error?.message ?? error)}`);
            return decision;
        }
    };

    return {
        listener,
        states,
        dispose() {
            states.clear();
        },
    };
}

/**
 * 把本插件的设置项注册到父插件的「设置 → 记忆」页。
 *
 * 父插件不一定已就绪（loader 并行启动），也不一定装了：先用裸 `ctx.get()`
 * 快速判定，拿不到就用作用域 `ctx.inject(['personaMemory'], …)` 等服务出现后补注册。
 * 两者都没有时静默跳过 —— 召回本身照常工作，只是没有页面开关。
 *
 * @param {any} ctx
 * @param {(key: string, raw: unknown) => Promise<void>} onChange
 * @param {Record<string, any>} config
 * @param {{ path: string }} store
 */
function registerSettings(ctx, config, store, onChange) {
    const items = createSettingItems({
        config,
        journalPath: store.path,
        onChange,
    });

    const attach = (scope) => {
        const service = scope?.get?.('personaMemory');
        if (service === undefined || typeof service?.settings?.register !== 'function') return;

        const handles = [];
        for (const item of items) {
            try {
                handles.push(service.settings.register(item));
            } catch (error) {
                ctx.logger?.warn?.(
                    `[persona-memory-recall] 设置项 ${item.id} 注册失败：${String(error?.message ?? error)}`,
                );
            }
        }
        if (handles.length === 0) return;

        const disposeAll = () => {
            for (const handle of handles.splice(0)) {
                try {
                    handle.dispose();
                } catch {
                    /* 父插件可能已先卸载 */
                }
            }
        };
        if (typeof scope.effect === 'function') scope.effect(() => disposeAll);
        else if (typeof ctx.effect === 'function') ctx.effect(() => disposeAll);

        ctx.logger?.info?.(`[persona-memory-recall] 已注册 ${handles.length} 个设置项到「记忆」页`);
    };

    if (typeof ctx.get === 'function' && ctx.get('personaMemory') !== undefined) {
        attach(ctx);
        return;
    }
    if (typeof ctx.inject === 'function') {
        ctx.inject(['personaMemory'], attach);
    }
}

/** 宿主入口：注册 pre-step 监听，挂到宿主组合后对所有 agent 预设生效。 */
export function apply(ctx, rawConfig) {
    const config = Config(rawConfig ?? {});

    // 设置页覆盖层：只覆盖用户显式改过的键，其余仍取组合配置。
    const overrides = readRecallOverrides();
    applyRecallOverrides(config, overrides);

    const configuredPath = typeof config.journalPath === 'string' ? config.journalPath.trim() : '';
    const file = configuredPath === '' ? defaultJournalPath() : configuredPath;

    const store = createJournalStore({
        file,
        scanEntries: config.scanEntries,
        chunkChars: config.chunkChars,
        maxChunksPerEntry: config.maxChunksPerEntry,
    });

    /**
     * 页面回写：先校验、再落盘、最后才改运行时 config。任一步失败都抛错，
     * 让页面保留旧值（父插件的注册表就是这个合同）。
     */
    const changeSetting = async (key, raw) => {
        const value = coerceSetting(key, raw);
        const next = { ...overrides, [key]: value };
        writeRecallOverrides(next);
        overrides[key] = value;
        config[key] = value;
        if (key === 'scanEntries' || key === 'chunkChars' || key === 'maxChunksPerEntry') {
            store.configure({
                scanEntries: config.scanEntries,
                chunkChars: config.chunkChars,
                maxChunksPerEntry: config.maxChunksPerEntry,
            });
        }
        ctx.logger?.info?.(`[persona-memory-recall] 设置已更新：${key} = ${String(value)}`);
    };

    const bound = createPreStepListener({
        config,
        store,
        memoryTextsFor: (session) => {
            const cwd = session?.header?.cwd;
            try {
                return readMemoryTexts(typeof cwd === 'string' ? cwd : undefined);
            } catch {
                return [];
            }
        },
        logger: ctx.logger,
    });

    ctx.on('agent/pre-step', bound.listener);

    ctx.on('agent/disposed', (payload) => {
        const id = payload?.agent?.id;
        if (typeof id === 'string') bound.states.delete(id);
    });

    registerSettings(ctx, config, store, changeSetting);

    ctx.logger?.info?.(
        `[persona-memory-recall] 就绪：日志 ${file}，每轮预算 ${config.maxChars} 字符（不改系统提示词，只追加本轮上下文）`,
    );
}
