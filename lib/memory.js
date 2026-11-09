/**
 * 读取「已经注入过的记忆」，用于召回去重。
 *
 * 召回片段如果和 FACT.md / 项目 MEMORY.md 里已有的内容重复，就是在白烧 token：
 * 前者每个主会话都会注入，后者在本项目每个会话都会注入。
 *
 * 只读，不改写任何文件；找不到就返回空数组。
 *
 * 失效条目过滤（DESIGN-memory-lifecycle.md 第 1、2、7 节）：
 *  主插件在**渲染层**就已经不再注入 `status=superseded|archived` 的条目，但文件里
 *  原文还在（「失效不删除」是可审计的前提）。如果召回侧继续把这份原文当成「模型
 *  已经看到的内容」去去重，就会出现最坏组合：一条过时结论既不被注入、又挡住能把
 *  它讲清楚的新日志 —— 两边都看不到，且完全不可见。
 *  所以这里先按契约把非 active 条目剔掉，再做去重；被剔掉的条目也不参与任何预算。
 *
 * 为什么独立实现而不 import 主插件：recall 是独立发布的包，只依赖 JOURNAL 的文件
 *  格式，不依赖主插件的源码与版本。状态注释的格式是跨包契约，两边各自实现、各自
 *  测试（主插件改动不会让本包 import 失败，本包也不会悄悄依赖主插件内部结构）。
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
 * 行尾状态注释。契约要求正文与注释间至少一个空格，但读侧不该因为少个空格就漏删。
 * 内部用 `(?:(?!-->)[\s\S])*` 而不是 `.`，是为了**不跨越 `-->`**：
 * 一行两个注释时，匹配会落在第二个 `<!--` 上，随后的 `body.includes('<!--')` 守卫
 * 就能把它判成格式错误（按 active 处理），而不是悄悄读了第一个注释。
 */
const STATE_COMMENT = /<!--\s*memory-state:((?:(?!-->)[\s\S])*)-->\s*$/u;
/**
 * 条目行：无序 `- ` / `* ` / `+ `，有序 `1. ` / `1) `。
 *
 * 为什么要判形态：FACT.md 全是 `- ` 条目，项目 MEMORY.md 的结论段是 `1. ` 编号条目、
 * `## 速查` 段又是 `- ` 条目，两种都要认；而标题、段首说明、代码块里的裸 `<!-- -->`
 * 不是条目，即使带状态注释也不能整行删掉（那会删掉文件结构）。
 */
const ENTRY_LINE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/u;
/** 只有这两个状态算「失效」；拼错、残缺、别的值一律当 active（契约要求容错）。 */
const INACTIVE_STATUS = new Set(['superseded', 'archived']);
/** `key=value` 字段；只认拉丁键名，避免把正文里的中文等号片段当字段。 */
const STATE_FIELD = /([a-z][a-z0-9_-]*)\s*=\s*([^\s]+)/giu;

const activeState = () => ({ status: 'active', by: '', since: '' });

/**
 * 解析一行的条目状态：剥离行尾状态注释，返回 `{ text, state }`。
 *
 * 与主插件 `entry-state.js` 的 `parseEntryState` 同口径（跨包契约），但这里只实现
 * 召回需要的部分：不提供写入、不做改写。容错优先 —— 任何解析不确定的情况都按
 * active 处理（宁可多注入一条过时结论，也不要把活条目误删成不可见）。
 *
 * @param {string} line 单行原文。
 * @returns {{ text: string, state: { status: 'active'|'superseded'|'archived', by: string, since: string } }}
 */
export function parseEntryState(line) {
    const original = String(line ?? '');
    if (!ENTRY_LINE.test(original)) return { text: original, state: activeState() };

    const match = STATE_COMMENT.exec(original);
    if (match === null) return { text: original, state: activeState() };

    const body = original.slice(0, match.index).trimEnd();
    // 注释之前还有 `<!--`：说明这行不是「正文 + 尾部状态」的形态，当普通行原样保留。
    if (body.includes('<!--')) return { text: original, state: activeState() };

    const fields = new Map();
    for (const field of match[1].matchAll(STATE_FIELD)) fields.set(field[1].toLowerCase(), field[2]);

    const state = activeState();
    const status = (fields.get('status') ?? '').toLowerCase();
    if (INACTIVE_STATUS.has(status)) state.status = status;
    state.by = fields.get('by') ?? '';
    state.since = fields.get('since') ?? '';
    return { text: body, state };
}

/**
 * 从整份文档剔除非 active 条目，返回新文本。
 *
 * 只删「整行条目 + 明确失效」的行，其余（标题、空行、段首说明、`## 速查` 里的参考
 * 条目、代码块）逐字节原样保留 —— 过滤的职责只是让失效条目不参与去重，不是重排文档。
 * 单行条目是契约的前提（状态内联在行尾，因为 FACT.md 只有 100 行），所以不需要
 * 处理「删了主行留下续行」的情况；真遇到带续行的方言也只删主行，不做猜测。
 *
 * @param {string} raw
 * @returns {string}
 */
export function stripInactiveEntries(raw) {
    const source = String(raw ?? '');
    if (source === '') return source;
    const kept = [];
    for (const line of source.split('\n')) {
        if (parseEntryState(line).state.status !== 'active') continue;
        kept.push(line);
    }
    return kept.join('\n');
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
 * 返回的是**过滤后**的文本（非 active 条目已剔除）：召回的去重语料必须与模型
 * 实际看到的内容一致，否则失效条目会变成「隐形的去重墙」。
 *
 * @param {string | undefined} cwd 会话工作目录。
 * @returns {string[]}
 */
export function readMemoryTexts(cwd) {
    const texts = [];
    const fact = readText(factPath());
    const activeFact = fact === null ? '' : stripInactiveEntries(fact);
    if (activeFact.trim() !== '') texts.push(activeFact);
    const project = findProjectMemory(cwd);
    if (project !== null) {
        const activeProject = stripInactiveEntries(project.content);
        if (activeProject.trim() !== '') texts.push(activeProject);
    }
    return texts;
}
