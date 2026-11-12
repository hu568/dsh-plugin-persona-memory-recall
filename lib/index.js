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
import { createCompactionWatch } from './compaction-watch.js';
import { createJournalStore, defaultJournalPath } from './journal.js';
import { readMemoryTexts } from './memory.js';
import { budgetViability, recall } from './recall.js';
import { buildRehydrate, pickRehydrateEntries } from './rehydrate.js';
import { createWorkspaceMatcher } from './workspace.js';
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
/** 压缩后重建包用独立的段落名，会话日志里一眼能分辨。 */
export const REHYDRATE_SECTION_NAME = 'memory:recall:rehydrate';

/** 日志仓库对外导出，方便测试与外部诊断脚本复用同一份缓存语义。 */
export { createJournalStore } from './journal.js';

export const Config = z.object({
    enabled: z.boolean().default(true),
    /** 日志路径；空串 = `$DSH_HOME/memory/JOURNAL.jsonl`。 */
    journalPath: z.string().default(''),
    /** 最多注入几段。 */
    topK: z.number().min(1).default(5),
    /** 旧键：整轮字符预算（0 = 用 `maxTotalChars`）。只做向后兼容，别新增引用。 */
    maxChars: z.number().min(0).default(600),
    /** 整轮总字符预算：前言 + 标签 + 正文全算（0 = 沿用 `maxChars`，默认 600）。 */
    maxTotalChars: z.number().min(0).default(600),
    /** 旧键：单段截断长度（0 = 用 `maxEntryChars`）。只做向后兼容。 */
    perChunkChars: z.number().min(0).default(240),
    /** 单条上限：标签 + 正文 + 截断后缀（0 = 沿用 `perChunkChars`，默认 240）。 */
    maxEntryChars: z.number().min(0).default(240),
    /** 剩余预算不够这么多字符就整条丢弃，不写半条。 */
    minEntryChars: z.number().min(8).default(40),
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
    /**
     * 与记忆文件的去重阈值（行级 2-gram Dice）。
     *
     * 0 = 关掉 Dice，只保留「整段原文被记忆包含」的确定性兜底；0.7 能挡住
     * 「同一结论换个说法」，又不会把只共享几个词的条目误杀。
     */
    dedupeDiceThreshold: z.number().min(0).max(1).default(0.7),
    /** 去重只比对这么长以上的行：太短的行（「注意」「已完成」）比了全是噪声。 */
    dedupeMinLineChars: z.number().min(0).default(12),
    /**
     * 按工作区隔离召回（ROADMAP B3）。
     *
     * JOURNAL 行带 cwd / workspaceId 时只召回同工作区（或同一项目根）的日志；
     * 没有归属字段的旧行一律放行。关掉它 = 回到「全局日志一锅搜」的旧行为。
     */
    workspaceIsolation: z.boolean().default(true),
    /** 命中词少于这个数时走覆盖率判定（0 = 关掉命中门槛）。 */
    minMatchedTokens: z.number().min(0).default(2),
    /** 单命中时的覆盖率门槛：罕见命中词 / 查询里索引内存在的词数（0 = 关）。 */
    minCoverage: z.number().min(0).max(1).default(0.15),
    /** 单命中豁免的罕见度上限：命中词 df/N 不超过该值才算罕见证据（0.2 = 20% 片段）。 */
    singleMatchMaxDfRatio: z.number().min(0).max(1).default(0.2),
    /** topK 分档：最高分达到 minScore 的几倍才允许占满 5 条。 */
    tierFullRatio: z.number().min(0).default(3),
    /** topK 分档：最高分达到 minScore 的几倍才允许占 4 条。 */
    tierHighRatio: z.number().min(0).default(2),
    /** topK 分档：最高分达到 minScore 的几倍才允许占 3 条（低于它只给 1 条）。 */
    tierMidRatio: z.number().min(0).default(1.5),
    /** 跨轮去重：同一片段注入过就不再注入（压缩成功时清空）。 */
    dedupeAcrossTurns: z.boolean().default(true),
    /** 查询只取用户消息的末尾这么多字符（防超长粘贴）。 */
    maxQueryChars: z.number().min(16).default(1500),
    /** 把每次注入/跳过的原因写进宿主日志。 */
    debug: z.boolean().default(false),
    /** 压缩后是否把「本会话最近 N 条日志」重建注入一次。 */
    rehydrate: z.boolean().default(true),
    /** 重建包最多回放多少条日志。 */
    maxRehydrateEntries: z.number().min(1).default(12),
    /** 重建包的总字符上限（含开头与尾注）。 */
    maxRehydrateChars: z.number().min(80).default(1200),
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

/**
 * 本轮消息里最后一条「真人用户消息」的下标；没有就返回 -1。
 *
 * 压缩重建包必须 splice 到这条**之前**（宿主契约同 meow）：如果只是追加到末尾，
 * 模型会把「压缩前的记忆」当成用户刚说的话，直接回应它。
 *
 * @param {any[] | undefined} messages `decision.messages`
 * @returns {number}
 */
export function lastUserIndex(messages) {
    if (!Array.isArray(messages)) return -1;
    for (let position = messages.length - 1; position >= 0; position -= 1) {
        if (isUserSourced(messages[position])) return position;
    }
    return -1;
}

/** 造一条快照式 user 消息（与宿主 `createUserMessage` 同形，但不依赖宿主包）。 */
function createRecallMessage(text, sectionName = SECTION_NAME) {
    return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
            kind: SOURCE_KIND,
            form: 'snapshot',
            sections: [{ name: sectionName, text }],
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
 *   watch?: any,
 * }} options
 * @returns {{ listener: (payload: any, next: () => any) => Promise<any>, states: Map<string, any>, dispose(): void }}
 */
export function createPreStepListener(options) {
    const { config, store, memoryTextsFor, logger, watch } = options;
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

            // 工作区隔离的会话侧依据：没有 cwd（归属未知）时判定器恒放行，绝不凭猜测丢日志。
            const cwd = typeof session?.header?.cwd === 'string' && session.header.cwd.trim() !== ''
                ? session.header.cwd
                : undefined;
            const allowWorkspace = createWorkspaceMatcher(cwd, {
                enabled: config.workspaceIsolation !== false,
            });

            let state = states.get(sessionId);
            if (state === undefined) {
                state = {
                    turn: undefined,
                    queryKey: '',
                    lastInjectedTurn: undefined,
                    /** 本会话已注入片段的指纹：跨轮去重（压缩成功后清空）。 */
                    injected: new Set(),
                    /** 上一次没注入的原因：页面/日志排查「为什么一条都没发」。 */
                    lastSkipReason: '',
                    /** 预算不足的告警是否已发过：避免每轮刷屏。 */
                    budgetWarned: false,
                };
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
                cwd,
                skipChunkHashes: config.dedupeAcrossTurns === false ? undefined : state.injected,
            });

            /*
             * 压缩后重建：只在本会话被标记、且本轮真有真人用户消息时走。
             *
             * 与 BM25 召回**二选一**（否则同一段历史会被注入两遍、白烧预算）：
             *  - BM25 已命中 → 本轮只走召回，保留标记等一个「没命中」的轮次再补；
             *  - BM25 没命中 → 用日志重建一包，splice 到本轮用户消息**之前**，注入成功即清标记；
             *  - 重建包为空（日志空 / 预算装不下）→ 也清标记，避免每轮空转。
             */
            if (config.rehydrate && typeof watch?.isPending === 'function' && watch.isPending(sessionId)) {
                if (result.text !== null) {
                    debug(`path=bm25（本轮已有召回命中，重建包保留到下一轮，turn ${turn}）`);
                } else {
                    const userIndex = lastUserIndex(decision.messages);
                    if (userIndex < 0) {
                        // 这一 step 没有真实用户消息（插件轮/续跑），等下一 step 再补，别清标记。
                        debug(`path=rehydrate: 跳过（本轮没有真实用户消息），保留标记（turn ${turn}）`);
                        return decision;
                    }
                    const marker = watch.marker?.(sessionId);
                    // 重建包也走工作区隔离：JOURNAL 是全局流水账，别把另一个工程的近期
                    // 日志当作「本会话压缩前的记忆」塞回来（无 cwd 的旧行照样放行）。
                    const packetEntries = pickRehydrateEntries({
                        entries: store.snapshot().entries,
                        sessionId,
                        compactedAt: marker?.compactedAt,
                        maxEntries: config.maxRehydrateEntries,
                    }).filter((entry) => allowWorkspace(entry));
                    const packet = buildRehydrate({ entries: packetEntries, config });
                    watch.clear?.(sessionId);
                    if (packet.text === null) {
                        debug(`path=rehydrate: 空包，已清标记（${packet.reason}，turn ${turn}）`);
                        return decision;
                    }
                    const messages = [...(decision.messages ?? [])];
                    messages.splice(userIndex, 0, createRecallMessage(packet.text, REHYDRATE_SECTION_NAME));
                    state.lastInjectedTurn = turn;
                    debug(
                        `path=rehydrate: ${packet.entries} 条 / ${packet.text.length} 字符，splice@${userIndex}（turn ${turn}）`,
                    );
                    return { ...decision, messages };
                }
            }

            if (result.text === null) {
                state.lastSkipReason = result.reason;
                if (result.reason === 'budget-too-small') {
                    // 「预算不足」是配置问题，不是「这轮没命中」：必须在宿主日志里可见；
                    // 但同一会话只提醒一次，否则预算填错后每轮都刷一行没人看。
                    if (state.budgetWarned !== true) {
                        state.budgetWarned = true;
                        const viability = budgetViability(config);
                        logger?.warn?.(
                            `[persona-memory-recall] 预算不足，未注入：每轮总额 ${result.budget.total} 字符 < 最少需要 ${viability.minRequired}`
                            + `（前言 ${viability.shell} + 最小一条 ${viability.min}），请调大「每轮字符预算」`,
                        );
                    }
                } else {
                    state.budgetWarned = false;
                }
                debug(`skip: ${result.reason} (turn ${turn})`);
                return decision;
            }

            state.lastInjectedTurn = turn;
            state.lastSkipReason = '';
            state.budgetWarned = false;

            // 跨轮去重：记下本轮真正注入的片段指纹，换措辞命中同一段也不再重注。
            if (config.dedupeAcrossTurns !== false) {
                for (const hit of result.hits) {
                    if (typeof hit.hash === 'string' && hit.hash !== '') state.injected.add(hit.hash);
                }
            }

            /*
             * 插位与重建包同口径：splice 到本轮最后一条真人用户消息**之前**。
             * 追加在用户消息之后时，模型最后读到的是工程日志 —— 语体被拉走，甚至把
             * 历史祈使句当成本轮待办；放到用户消息之前，本轮意图才是模型最后看到的。
             * 工具循环的 step>1 没有真人消息可插（userIndex<0），退回末尾。
             */
            const userIndex = lastUserIndex(decision.messages);
            const messages = [...(decision.messages ?? [])];
            const at = userIndex >= 0 ? userIndex : messages.length;
            messages.splice(at, 0, createRecallMessage(result.text));
            debug(`inject: ${result.hits.length} hit(s), ${result.usedChars} chars, splice@${at} (turn ${turn})`);

            return { ...decision, messages };
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
 * 处理一条 session 事件：压缩成功后清「待重建」标记，同时清空该会话的跨轮去重集合。
 *
 * 为什么压缩成功就要清去重集合：压缩以后那些召回块已经不在上下文里了，再注入
 * 同一段不是「重复」，而是「补回被逐出的信息」；不清空反而会让模型在压缩后失忆。
 *
 * 单独导出是为了让测试能直接驱动这条链路（不用起真宿主）。
 *
 * @param {{ states: Map<string, any> }} bound createPreStepListener() 的返回值。
 * @param {{ handleEvent(session: any, event: any): boolean }} watch 压缩标记仓库。
 * @param {any} session
 * @param {any} event
 * @returns {boolean} 是否是一条「成功的压缩结束」事件。
 */
export function handleSessionEvent(bound, watch, session, event) {
    const handled = watch.handleEvent(session, event);
    if (!handled) return false;
    const id = typeof session?.id === 'string' ? session.id : '';
    if (id === '') return true;
    const state = bound?.states?.get(id);
    if (state?.injected instanceof Set) state.injected.clear();
    return true;
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
    const rawInput = rawConfig ?? {};
    const explicitTotal = typeof rawInput.maxTotalChars === 'number' && rawInput.maxTotalChars > 0;
    const explicitEntry = typeof rawInput.maxEntryChars === 'number' && rawInput.maxEntryChars > 0;
    const config = Config(rawInput);

    // 旧键兼容：老组合配置只写了 maxChars / perChunkChars 时，让新键跟着旧键走。
    // （Config 的新键有默认值，因此「用户到底写没写」只能在归一化之前判断。）
    if (!explicitTotal && config.maxChars > 0) config.maxTotalChars = Math.max(80, config.maxChars);
    if (!explicitEntry && config.perChunkChars > 0) config.maxEntryChars = Math.max(40, config.perChunkChars);

    // 设置页覆盖层：只覆盖用户显式改过的键，其余仍取组合配置。
    const overrides = readRecallOverrides();
    applyRecallOverrides(config, overrides);
    // 页面上的「每轮字符预算」沿用旧键 maxChars，写回后要镜像到新键才算生效。
    if (typeof overrides.maxChars === 'number') config.maxTotalChars = Math.max(80, overrides.maxChars);

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
        if (key === 'maxChars') config.maxTotalChars = Math.max(80, value);
        if (key === 'scanEntries' || key === 'chunkChars' || key === 'maxChunksPerEntry') {
            store.configure({
                scanEntries: config.scanEntries,
                chunkChars: config.chunkChars,
                maxChunksPerEntry: config.maxChunksPerEntry,
            });
        }
        ctx.logger?.info?.(`[persona-memory-recall] 设置已更新：${key} = ${String(value)}`);
    };

    /** 压缩标记仓库：落盘到 `$DSH_HOME/memory/recall/pending-rehydrate.json`。 */
    const watch = createCompactionWatch({ logger: ctx.logger });

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
        watch: config.rehydrate ? watch : undefined,
    });

    ctx.on('agent/pre-step', bound.listener);

    /*
     * 压缩监听：`compaction/end` 且 data.error 为空才算成功。
     * 事件回调是宿主线程直接调的，任何异常都在这里吞掉 —— 打标记失败最多丢一次
     * 重注入，绝不让宿主的 session/event 派发出错。
     */
    ctx.on('session/event', (session, event) => {
        try {
            handleSessionEvent(bound, watch, session, event);
        } catch (error) {
            ctx.logger?.warn?.(
                `[persona-memory-recall] 压缩事件处理失败（已忽略）: ${String(error?.message ?? error)}`,
            );
        }
    });

    ctx.on('agent/disposed', (payload) => {
        const id = payload?.agent?.id;
        if (typeof id === 'string') bound.states.delete(id);
    });

    registerSettings(ctx, config, store, changeSetting);

    /*
     * 预算装不下「前言 + 最小一条」时，页面照样显示「每轮自动召回：开」，实际一条都
     * 注不进去。启动日志里先把它说清楚，否则用户只会以为插件没生效。
     */
    const viability = budgetViability(config);
    if (config.enabled && !viability.ok) {
        ctx.logger?.warn?.(
            `[persona-memory-recall] 预算不足，未注入：每轮总额 ${viability.total} 字符 < 最少需要 ${viability.minRequired}`
            + `（前言 ${viability.shell} + 最小一条 ${viability.min}），请调大「每轮字符预算」`,
        );
    }

    ctx.logger?.info?.(
        `[persona-memory-recall] 就绪：日志 ${file}，每轮预算 ${config.maxTotalChars} 字符、`
        + `单条 ${config.maxEntryChars}（不改系统提示词，只追加本轮上下文）`,
    );
}
