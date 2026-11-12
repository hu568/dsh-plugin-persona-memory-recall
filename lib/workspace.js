/**
 * 工作区归属：把 JOURNAL 行的 cwd 与会话 cwd 对上，决定这一段能不能进本轮召回。
 *
 * 背景（ROADMAP 方向 B3）：JOURNAL 是全局流水账，召回过去只把 cwd 用于去重、不用于
 * 过滤，于是「看书学习」的会话会命中工程日志（实测 3.14 分）、学习空间的提问会命中
 * 另一套插件的日志（9.42 分）。语体被带偏，模型还可能把别的工程待办当成自己的任务。
 *
 * 跨包契约（Lead 定的，三包各自实现、互相不 import）：
 *  - JOURNAL 行可选 `cwd` / `workspaceId` 字段（写入侧归一，缺省不写字段）；
 *  - 有 cwd ⇒ 参与过滤；无 cwd 的旧行 ⇒ fail-open 放行（历史数据不能因为缺字段就消失）。
 *
 * 判定规则（从宽到窄）：
 *  1. workspaceId 与会话归一后的路径相等 → 同一工作区；
 *  2. cwd 互为前缀（含等于，按路径分隔符边界）→ 同一工作区；「从子目录往上追溯父目录」
 *     不算跨区，否则在子目录里开的会话永远召回不到项目根写的日志；
 *  3. 两者的项目根（最近的 `.git` 目录）相同 → 同一项目根；
 *  4. 其余 → 跨区，过滤。当前会话没有 cwd（归属未知）时一律放行。
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** 项目根标记：有 `.git` 的目录即项目根（与主插件 / consolidate 同口径）。 */
const PROJECT_MARKERS = ['.git'];

/**
 * 归一化路径：反斜杠转正斜杠、去尾部斜杠、Windows 盘符统一小写。
 *
 * 为什么不用 `path.resolve()`：测试与跨平台历史日志里会出现 Windows 风格的
 * `C:/work`，在 Linux 上 resolve 会把它拼成 `/root/.../C:/work`，前缀比较直接失效。
 *
 * @param {unknown} input
 * @returns {string} 归一后的路径；空输入返回空串。
 */
export function normalizeWorkspacePath(input) {
    let value = String(input ?? '').trim().replace(/\\/g, '/');
    if (value === '') return '';
    value = value.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    if (value === '') return '/';
    if (/^[a-z]:\//i.test(value)) value = value.toLowerCase();
    return value;
}

/**
 * 找最近的 `.git` 目录当项目根；找不到返回空串（比如 /tmp 下的临时语料）。
 *
 * 只认能直接 stat 的绝对 POSIX 路径：Windows 风格的 `C:/work` 在 Linux 上没法探，
 * 交给前缀规则处理（fail-open，不因为探测不了就误过滤）。
 *
 * @param {unknown} input
 * @returns {string}
 */
export function findProjectRoot(input) {
    let current = normalizeWorkspacePath(input);
    if (current === '' || !current.startsWith('/')) return '';
    for (let depth = 0; depth < 32; depth += 1) {
        if (PROJECT_MARKERS.some((marker) => existsSync(`${current}/${marker}`))) return current;
        if (current === '/') return '';
        const parent = dirname(current);
        if (parent === current) return '';
        current = parent;
    }
    return '';
}

/**
 * 两个 cwd 是否属于同一工作区（等于 / 互为父子 / 同一项目根）。
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function isSameWorkspace(left, right) {
    const a = normalizeWorkspacePath(left);
    const b = normalizeWorkspacePath(right);
    if (a === '' || b === '') return false;
    if (a === b) return true;
    if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
    const rootA = findProjectRoot(a);
    if (rootA === '') return false;
    return rootA === findProjectRoot(b);
}

/**
 * 造一个「这一行允许召回吗」的判定器。
 *
 * 当前会话没有 cwd 时不建过滤器（返回恒 true）：不知道自己在哪个工作区，就没有
 * 依据丢别人的数据，宁可多注入也不能让用户觉得「记忆丢了」。
 *
 * @param {unknown} currentCwd 会话 cwd（`session.header.cwd`）。
 * @param {{ enabled?: boolean }} [options] `enabled:false` 对应设置页的「按工作区隔离」开关。
 * @returns {(entry: { cwd?: string, workspaceId?: string } | null | undefined) => boolean}
 */
export function createWorkspaceMatcher(currentCwd, options = {}) {
    const enabled = options.enabled !== false;
    const current = normalizeWorkspacePath(currentCwd);
    if (!enabled || current === '') return () => true;

    // 项目根探测要 stat 父目录；同一轮里几百个片段大多来自同几个 cwd，缓存后只探几次。
    const rootCache = new Map();
    const rootOf = (value) => {
        if (!rootCache.has(value)) rootCache.set(value, findProjectRoot(value));
        return rootCache.get(value);
    };
    const currentRoot = rootOf(current);

    return (entry) => {
        if (entry === null || typeof entry !== 'object') return true;

        const rowCwd = normalizeWorkspacePath(entry.cwd);
        // 旧行（没有 cwd 字段）：fail-open。workspaceId 只当正向信号，不能单凭它判跨区。
        if (rowCwd === '') return true;

        const rowWorkspace = typeof entry.workspaceId === 'string' ? normalizeWorkspacePath(entry.workspaceId) : '';
        if (rowWorkspace !== '' && rowWorkspace === current) return true;

        if (rowCwd === current) return true;
        if (rowCwd.startsWith(`${current}/`) || current.startsWith(`${rowCwd}/`)) return true;

        if (currentRoot !== '') return currentRoot === rootOf(rowCwd);
        return false;
    };
}
