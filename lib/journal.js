/**
 * JOURNAL.jsonl 的读取、切段与索引缓存。
 *
 * 日志是**无上限增长**的流水账（父插件的设计），所以这里：
 *  - 只索引尾部 `scanEntries` 条；
 *  - 用 `mtimeMs:size` 做缓存键，文件没变就不重读、不重建；
 *  - 坏行跳过（历史脏数据不该让召回整个挂掉）。
 *
 * 归属字段（跨包契约，Lead 2026-11-12 定）：每行可选 `cwd` / `workspaceId`。
 * 这里只负责**原样带出**，缺字段就是 undefined（不是 null）：读侧据此 fail-open 放行，
 * 旧日志一行都不会因为升级后突然召不到。过滤逻辑在 `workspace.js`。
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from './bm25.js';
import { chunkText } from './chunk.js';
import { chunkHash } from './hash.js';
import { tokenize } from './tokenize.js';

/** 默认日志路径：与父插件 `@dsh-external/dsh-persona-memory` 同口径。 */
export function defaultJournalPath() {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(home, 'memory', 'JOURNAL.jsonl');
}

/** 空快照（文件不存在/读不了时用）。 */
function emptySnapshot(file, total = 0) {
    return {
        file,
        bytes: 0,
        total,
        entries: [],
        chunks: [],
        index: buildIndex([]),
        builtAt: 0,
    };
}

/**
 * 读尾部并把每条切成片段，返回带倒排的快照。
 *
 * @param {string} file 日志路径。
 * @param {number} scanEntries 最多索引多少条（从尾部数）。
 * @param {number} chunkChars 片段长度上限。
 * @param {number} maxChunksPerEntry 每条最多切几段。
 * @param {number} bytes 文件字节数（缓存统计用）。
 */
function buildSnapshot(file, scanEntries, chunkChars, maxChunksPerEntry, bytes) {
    let raw = '';
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        return emptySnapshot(file);
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
    const total = lines.length;
    const start = scanEntries > 0 ? Math.max(0, total - scanEntries) : 0;
    const entries = [];

    for (let position = start; position < total; position += 1) {
        try {
            const record = JSON.parse(lines[position]);
            if (record === null || typeof record !== 'object') continue;
            const text = typeof record.text === 'string' ? record.text.trim() : '';
            if (text === '') continue;
            const cwd = typeof record.cwd === 'string' && record.cwd.trim() !== '' ? record.cwd.trim() : undefined;
            const workspaceId = typeof record.workspaceId === 'string' && record.workspaceId.trim() !== ''
                ? record.workspaceId.trim()
                : undefined;
            entries.push({
                ts: typeof record.ts === 'string' ? record.ts : '',
                tags: Array.isArray(record.tags)
                    ? record.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '')
                    : [],
                text,
                // 只有真的带了字段才出现这两个键：缺字段必须能被 `entry.cwd === undefined` 认出来。
                ...(cwd === undefined ? {} : { cwd }),
                ...(workspaceId === undefined ? {} : { workspaceId }),
            });
        } catch {
            /* 坏行跳过 */
        }
    }

    const chunks = [];
    const docs = [];
    for (const entry of entries) {
        for (const text of chunkText(entry.text, { maxChars: chunkChars, maxChunks: maxChunksPerEntry })) {
            const tokens = tokenize(text);
            // tag 双倍计入：同一段内容里，标签命中的片段更容易被召回。
            for (const tag of entry.tags) {
                for (const token of tokenize(tag)) tokens.push(token, token);
            }
            // 指纹按原始片段正文算：渲染时的截断/标签/开窗都不该改变它的身份（跨轮去重用）。
            chunks.push({ entry, text, hash: chunkHash(text) });
            docs.push(tokens);
        }
    }

    return {
        file,
        bytes,
        total,
        entries,
        chunks,
        index: buildIndex(docs),
        builtAt: Date.now(),
    };
}

/**
 * 建一个按文件状态缓存的日志仓库。
 *
 * 索引参数可在运行时通过 `configure()` 重配（设置页改「索引日志条数」时用）：
 * 参数变了就丢掉缓存，下次 `snapshot()` 按新参数重建。
 *
 * @param {{ file: string, scanEntries: number, chunkChars: number, maxChunksPerEntry: number }} options
 * @returns {{
 *   path: string,
 *   configure(patch: { scanEntries?: number, chunkChars?: number, maxChunksPerEntry?: number }): any,
 *   snapshot(): ReturnType<typeof emptySnapshot>,
 * }}
 */
export function createJournalStore(options) {
    const { file } = options;
    const settings = {
        scanEntries: options.scanEntries,
        chunkChars: options.chunkChars,
        maxChunksPerEntry: options.maxChunksPerEntry,
    };
    let cache = null;

    const store = {
        get path() {
            return file;
        },
        /**
         * 改索引参数；有变化才清缓存，避免无谓重建。
         * @param {{ scanEntries?: number, chunkChars?: number, maxChunksPerEntry?: number }} patch
         */
        configure(patch) {
            let changed = false;
            for (const key of ['scanEntries', 'chunkChars', 'maxChunksPerEntry']) {
                const next = patch?.[key];
                if (Number.isFinite(next) && next !== settings[key]) {
                    settings[key] = next;
                    changed = true;
                }
            }
            if (changed) cache = null;
            return store;
        },
        /**
         * 取当前快照；文件状态没变就返回同一个对象。
         * @returns {ReturnType<typeof emptySnapshot>}
         */
        snapshot() {
            let stat;
            try {
                stat = statSync(file);
            } catch {
                return emptySnapshot(file);
            }
            if (!stat.isFile()) return emptySnapshot(file);

            const key = `${stat.mtimeMs}:${stat.size}`;
            if (cache !== null && cache.key === key) return cache.value;

            const value = buildSnapshot(
                file,
                settings.scanEntries,
                settings.chunkChars,
                settings.maxChunksPerEntry,
                stat.size,
            );
            cache = { key, value };
            return value;
        },
    };

    return store;
}
