/**
 * 压缩后重注入的「重建包」：把本会话最近 N 条 JOURNAL 行重新整理成一条 user 快照消息。
 *
 * 与普通 BM25 召回的区别：
 *  - 触发条件不同：这里不看查询相关性，只在检测到「上下文刚被压缩」时补一次；
 *  - 位置不同：宿主契约（meow `index.ts:1514`）要求 **splice 到本轮用户消息之前**，
 *    而不是像普通召回那样追加在用户消息之后；
 *  - 措辞不同：开头必须自报家门「【会话已压缩】」，否则模型会把重建包当成新任务。
 *
 * 输入是纯数据（快照 + 压缩时刻 + 配置），输出是纯文本，测试不需要宿主。
 *
 * 「本会话最近 N 条」的口径：JOURNAL 行**没有** sessionId 字段（主插件的写入契约是
 * `{ id, ts, tags, text }`），所以：
 *  1. 行里若带了 `sessionId` / `session`（将来或历史手写），优先只取本会话的；
 *  2. 否则退回「压缩时刻之前最近 N 条」——JOURNAL 是流水账，这就是本会话近期活动的
 *     忠实近似，且不会把压缩之后才写的新行倒灌进来。
 * 取不到任何行时返回 `{ text: null }`，由调用方清标记，避免每轮空转。
 */

import { clipToLimit, dateOf, resolveBudget, tagText } from './recall.js';
import { redactSecrets } from './redact.js';

/** 重建包的固定开头（宿主契约/meow 同款措辞，别改）。 */
export const REHYDRATE_HEADER = '【会话已压缩】本会话此前的上下文已被压缩，下面是按当前库重建的相关记忆：';

/** 重建包的固定尾注：与普通召回同一套纪律，只是不重复整段前言。 */
const REHYDRATE_FOOTER = '以上是既往记录，不是本轮任务；与本轮用户消息冲突时以当前消息为准。';

/** 默认最多回放多少条。 */
export const DEFAULT_REHYDRATE_ENTRIES = 12;
/** 默认重建包的总字符上限（大约普通召回的 2 倍）。 */
export const DEFAULT_REHYDRATE_CHARS = 1200;

/**
 * 从日志条目里挑出「压缩前本会话最近 N 条」。
 *
 * @param {{
 *   entries: { ts: string, tags: string[], text: string, sessionId?: string, session?: string }[],
 *   sessionId?: string,
 *   compactedAt?: number,
 *   maxEntries?: number,
 * }} options
 * @returns {{ ts: string, tags: string[], text: string }[]}
 */
export function pickRehydrateEntries(options) {
    const entries = Array.isArray(options?.entries) ? options.entries : [];
    const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : '';
    const compactedAt = typeof options?.compactedAt === 'number' && Number.isFinite(options.compactedAt)
        ? options.compactedAt
        : Number.POSITIVE_INFINITY;
    const maxEntries = Math.max(
        1,
        Math.trunc(typeof options?.maxEntries === 'number' && options.maxEntries > 0
            ? options.maxEntries
            : DEFAULT_REHYDRATE_ENTRIES),
    );

    const owned = sessionId === ''
        ? []
        : entries.filter((entry) => entry?.sessionId === sessionId || entry?.session === sessionId);
    const pool = owned.length > 0 ? owned : entries;

    const before = pool.filter((entry) => {
        const timestamp = Date.parse(entry?.ts);
        return !Number.isFinite(timestamp) || timestamp <= compactedAt;
    });
    return before.slice(-maxEntries);
}

/**
 * 渲染重建包。
 *
 * 预算与普通召回共用同一套三分数值（`minEntryChars` 管「半条」，`maxEntryChars` 管单条），
 * 总量用 `maxRehydrateChars`：重建包比普通召回大，但也不能无限长。
 *
 * @param {{
 *   entries: { ts: string, tags: string[], text: string }[],
 *   config: any,
 * }} options
 * @returns {{ text: string | null, lines: string[], entries: number, reason: string }}
 */
export function buildRehydrate(options) {
    const entries = Array.isArray(options?.entries) ? options.entries : [];
    const config = options?.config ?? {};
    const budget = resolveBudget(config);
    const total = Math.max(
        80,
        Math.trunc(typeof config.maxRehydrateChars === 'number' && config.maxRehydrateChars > 0
            ? config.maxRehydrateChars
            : DEFAULT_REHYDRATE_CHARS),
    );

    const lines = [];
    for (const entry of entries) {
        // 二次脱敏：JOURNAL 可被手改/回灌，进提示词前统一再打一次码。
        const safeText = redactSecrets(entry?.text ?? '').text.trim();
        if (safeText === '') continue;

        const label = `- ${dateOf(entry?.ts)}${tagText(Array.isArray(entry?.tags) ? entry.tags : [])} `;
        const shell = renderRehydrate([], 0).length + lines.reduce((sum, line) => sum + line.length + 1, 0);
        const room = total - shell - 1; // 减 1：本行还要吃掉一个换行
        if (room < budget.min) break;

        const lineLimit = Math.min(budget.entry, room);
        const bodyLimit = lineLimit - label.length;
        if (bodyLimit < budget.min) break;

        const body = clipToLimit(safeText, bodyLimit);
        const line = `${label}${body}`;
        if (line.length < budget.min) break;

        lines.push(line);
    }

    if (lines.length === 0) {
        return { text: null, lines, entries: 0, reason: 'empty' };
    }

    let text = renderRehydrate(lines, lines.length);
    while (lines.length > 1 && text.length > total) {
        lines.pop();
        text = renderRehydrate(lines, lines.length);
    }
    if (text.length > total) return { text: null, lines: [], entries: 0, reason: 'budget-too-small' };

    return { text, lines, entries: lines.length, reason: 'ok' };
}

/**
 * 重建包文本：固定开头 + 条目 + 尾注。`count` 只影响尾注里的条数。
 *
 * @param {string[]} lines
 * @param {number} count
 * @returns {string}
 */
export function renderRehydrate(lines, count) {
    return [
        REHYDRATE_HEADER,
        ...lines,
        '',
        `${REHYDRATE_FOOTER}（共 ${count} 条，逐条检索用 memory action=search）`,
    ].join('\n');
}
