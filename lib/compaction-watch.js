/**
 * 压缩后重注入的「待办标记」：监听宿主压缩事件，标记该会话需要重建记忆。
 *
 * 背景（宿主事实，已在 /opt/dsh 交叉验证）：
 *  - 压缩是 SessionEvent：`compaction/start|summary|end|prune`；
 *  - `compaction/end` 的 `data.error` 为空（undefined / null / ''）才算**成功**——
 *    压缩失败的会话内容并没有被逐出，这时打标记会让下一轮凭空多注入一包记忆；
 *  - 插件拿到的是 `ctx.on('session/event', (session, event) => …)`，键用 `session.id`
 *    （宿主保证 `agent.id === session.id`）。
 *
 * 为什么要落盘：压缩可能发生在插件重启/宿主重启之前；标记只存内存的话，重启后
 * 「上下文已经没了」这件事就永久查不到，用户会看到模型突然失忆。
 *
 * 落盘纪律（与主插件同口径）：
 *  - 原子写：同目录 tmp 文件 + rename，绝不出现半截 JSON；
 *  - 坏文件当空：手改坏、写一半断电都只损失「这一次重注入」，不炸插件；
 *  - 启动清理超过 1 天的项：隔天再注入一包「压缩前的记忆」只会制造混乱。
 *
 * 所有 IO 失败都吞掉并记 warn：召回是锦上添花，不能因为它让 turn 失败。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataHome } from './memory.js';

/** 标记默认存多久：超过一天就不值得再往上下文里塞「压缩前的记忆」了。 */
export const PENDING_MAX_AGE_MS = 86_400_000;

/** 标记文件版本号；将来换结构时用来判断要不要丢弃旧文件。 */
const FILE_VERSION = 1;

/** 标记文件路径：`$DSH_HOME/memory/recall/pending-rehydrate.json`。 */
export function pendingRehydratePath() {
    return join(dataHome(), 'memory', 'recall', 'pending-rehydrate.json');
}

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 会话键：只认非空字符串 id（`agent.id` 与 `session.id` 由宿主保证相同）。 */
export function sessionKeyOf(session) {
    const id = session?.id;
    return typeof id === 'string' && id !== '' ? id : '';
}

/**
 * 判断一条 session 事件是否代表「压缩成功」。
 *
 * @param {any} event
 * @returns {boolean}
 */
export function isSuccessfulCompaction(event) {
    if (event === null || typeof event !== 'object') return false;
    if (event.type !== 'compaction/end') return false;
    const data = event.data;
    if (data === null || typeof data !== 'object') return false;
    const error = data.error;
    // 宿主只在成功时省掉 error 字段；空串是旧版本/自定义路径的等价写法。
    return error === undefined || error === null || error === '';
}

/**
 * 造一个压缩标记仓库。
 *
 * @param {{
 *   file?: string,
 *   logger?: { warn?(message: string): void, info?(message: string): void },
 *   now?: () => number,
 *   maxAgeMs?: number,
 * }} [options]
 * @returns {{
 *   file: string,
 *   size: number,
 *   handleEvent(session: any, event: any): boolean,
 *   mark(sessionId: string, at?: number): void,
 *   isPending(sessionId: string): boolean,
 *   marker(sessionId: string): { compactedAt: number } | undefined,
 *   clear(sessionId: string): boolean,
 *   prune(at?: number): number,
 *   snapshot(): Record<string, { compactedAt: number }>,
 * }}
 */
export function createCompactionWatch(options = {}) {
    const file = typeof options.file === 'string' && options.file !== '' ? options.file : pendingRehydratePath();
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const maxAgeMs = finiteNumber(options.maxAgeMs) ?? PENDING_MAX_AGE_MS;
    const logger = options.logger;

    /** @type {Map<string, { compactedAt: number }>} */
    const sessions = new Map();

    const warn = (message, error) => {
        try {
            logger?.warn?.(`[persona-memory-recall] ${message}（已忽略）: ${String(error?.message ?? error)}`);
        } catch {
            /* 日志本身失败也不能影响调用方 */
        }
    };

    function persist() {
        try {
            mkdirSync(dirname(file), { recursive: true });
            const payload = {
                version: FILE_VERSION,
                sessions: Object.fromEntries([...sessions].sort(([left], [right]) => left.localeCompare(right))),
            };
            const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
            writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
            renameSync(tmp, file);
            return true;
        } catch (error) {
            warn('压缩标记落盘失败', error);
            return false;
        }
    }

    /** 读盘：坏文件/坏结构当空；顺带清掉超过 maxAgeMs 的项。 */
    function load() {
        let raw;
        try {
            raw = readFileSync(file, 'utf8');
        } catch {
            return; // 文件不存在：正常首次启动
        }

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            warn('压缩标记文件不是合法 JSON，按空处理', new Error(file));
            return;
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;

        const map = parsed.sessions !== undefined && parsed.sessions !== null && typeof parsed.sessions === 'object'
            ? parsed.sessions
            : undefined;
        if (map === undefined) return;
        if (parsed.version !== undefined && parsed.version !== FILE_VERSION) return;

        const cutoff = now() - maxAgeMs;
        let pruned = 0;
        for (const [id, value] of Object.entries(map)) {
            if (typeof id !== 'string' || id === '') continue;
            const at = finiteNumber(value?.compactedAt);
            if (at === undefined) continue;
            if (at < cutoff) {
                pruned += 1;
                continue;
            }
            sessions.set(id, { compactedAt: at });
        }
        if (pruned > 0) {
            logger?.info?.(`[persona-memory-recall] 清理 ${pruned} 个过期的压缩标记（>${Math.round(maxAgeMs / 3_600_000)}h）`);
            persist();
        }
    }

    load();

    const watch = {
        get file() {
            return file;
        },
        get size() {
            return sessions.size;
        },
        /** 监听入口：只有「成功的 compaction/end」才置位。 */
        handleEvent(session, event) {
            if (!isSuccessfulCompaction(event)) return false;
            const id = sessionKeyOf(session);
            if (id === '') return false;
            sessions.set(id, { compactedAt: now() });
            persist();
            try {
                logger?.info?.(`[persona-memory-recall] 会话 ${id} 已压缩，下一轮重建记忆`);
            } catch {
                /* ignore */
            }
            return true;
        },
        mark(sessionId, at = now()) {
            if (typeof sessionId !== 'string' || sessionId === '') return;
            sessions.set(sessionId, { compactedAt: finiteNumber(at) ?? now() });
            persist();
        },
        isPending(sessionId) {
            return typeof sessionId === 'string' && sessions.has(sessionId);
        },
        marker(sessionId) {
            return typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
        },
        clear(sessionId) {
            if (typeof sessionId !== 'string') return false;
            if (!sessions.delete(sessionId)) return false;
            persist();
            return true;
        },
        /** 清掉过期的项（构造时自动跑一次，这里给测试/诊断用）。 */
        prune(at = now()) {
            const cutoff = at - maxAgeMs;
            let pruned = 0;
            for (const [id, value] of sessions) {
                if (value.compactedAt < cutoff) {
                    sessions.delete(id);
                    pruned += 1;
                }
            }
            if (pruned > 0) persist();
            return pruned;
        },
        snapshot() {
            return Object.fromEntries([...sessions]);
        },
    };

    return watch;
}
