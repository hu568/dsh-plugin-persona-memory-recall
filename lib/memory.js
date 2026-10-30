/**
 * 读取「已经注入过的记忆」，用于召回去重。
 *
 * 召回片段如果和 FACT.md / 项目 MEMORY.md 里已有的内容重复，就是在白烧 token：
 * 前者每个主会话都会注入，后者在本项目每个会话都会注入。
 *
 * 只读，不改写任何文件；找不到就返回空数组。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';

const PROJECT_MEMORY_FILE = 'MEMORY.md';

/** `$DSH_HOME`，与宿主的默认值一致。 */
export function dataHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 全局记忆文件路径。 */
export function factPath() {
    return join(dataHome(), 'memory', 'FACT.md');
}

function readText(file) {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

/**
 * 从会话 cwd 向上找项目根：先命中 MEMORY.md 的目录即项目根；
 * 若先遇到 `.git` 或 home 目录则认为项目根没有记忆文件。
 *
 * 语义与父插件 `findProjectMemory()` 保持一致。
 *
 * @param {string | undefined} cwd
 * @returns {{ root: string, path: string, content: string } | null}
 */
export function findProjectMemory(cwd) {
    if (typeof cwd !== 'string' || cwd.trim() === '') return null;
    let dir = resolvePath(cwd);
    const home = homedir();
    for (let depth = 0; depth < 24; depth += 1) {
        const candidate = join(dir, PROJECT_MEMORY_FILE);
        if (existsSync(candidate)) {
            return { root: dir, path: candidate, content: readText(candidate) ?? '' };
        }
        if (dir === home) return null;
        if (existsSync(join(dir, '.git'))) return null;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
}

/**
 * 本会话已经注入过的记忆正文（全局 + 项目）。
 *
 * @param {string | undefined} cwd 会话工作目录。
 * @returns {string[]}
 */
export function readMemoryTexts(cwd) {
    const texts = [];
    const fact = readText(factPath());
    if (fact !== null && fact.trim() !== '') texts.push(fact);
    const project = findProjectMemory(cwd);
    if (project !== null && project.content.trim() !== '') texts.push(project.content);
    return texts;
}
