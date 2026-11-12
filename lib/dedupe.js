/**
 * 与 FACT.md / 项目 MEMORY.md 的去重：按行 + Dice 系数。
 *
 * 为什么不再用「整个 chunk 被子串包含」：chunk 是 240~300 字符的窗口，记忆文件里
 * 的条目是单行结论；短条目几乎不可能包含整个 chunk，于是召回侧会把「模型刚在系统
 * 提示词里看过的结论」再注入一遍 —— 白烧预算，还让模型看到同一个结论的两种措辞。
 *
 * 为什么是 Dice 而不是编辑距离 / 向量：条目是自然语言，措辞会变（同义改写、语序），
 * 2-gram 的 Dice 对顺序不敏感、对增删宽容，且直接复用现有 tokenize（零依赖）。
 *
 * 判定口径：
 *  - 先把记忆文件切成**行**（去掉列表符号），只保留长度 ≥ `minLineChars` 的行；
 *  - chunk 也按行切成片段，任一行与任一记忆行的 Dice ≥ 阈值即判重复；
 *  - 阈值 0 表示关掉 Dice（只剩「整段原文被记忆包含」这条确定性兜底）。
 */

import { tokenize } from './tokenize.js';

/** 默认相似阈值：0.7 能挡住「同一结论换个说法」，又不会把只共享几个词的条目误杀。 */
export const DEFAULT_DICE_THRESHOLD = 0.7;
/** 默认只比这么长以上的行：太短的行（「注意」「已完成」）比了全是噪声。 */
export const DEFAULT_MIN_LINE_CHARS = 12;

/** 列表符号：记忆文件里条目是 `- ` / `1. `，chunk 里可能带 markdown 列表。 */
const LIST_MARKER = /^(?:[-*+•]|\d+[.)])\s+/u;

/**
 * 把文本切成用于逐行比对的行：去首尾空白、去列表符号、丢空行。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitDedupeLines(text) {
    const lines = [];
    for (const raw of String(text ?? '').split('\n')) {
        const line = raw.trim().replace(LIST_MARKER, '');
        if (line !== '') lines.push(line);
    }
    return lines;
}

/**
 * 2-gram 多重集 Dice 系数：`2·|A∩B| / (|A|+|B|)`。
 *
 * @param {string[]} aTokens
 * @param {string[]} bTokens
 * @returns {number} 0–1；任一侧为空时返回 0。
 */
export function diceCoefficient(aTokens, bTokens) {
    const lenA = Array.isArray(aTokens) ? aTokens.length : 0;
    const lenB = Array.isArray(bTokens) ? bTokens.length : 0;
    if (lenA === 0 || lenB === 0) return 0;

    const [small, large] = lenA <= lenB ? [aTokens, bTokens] : [bTokens, aTokens];
    const counts = new Map();
    for (const token of large) counts.set(token, (counts.get(token) ?? 0) + 1);

    let common = 0;
    for (const token of small) {
        const count = counts.get(token) ?? 0;
        if (count === 0) continue;
        counts.set(token, count - 1);
        common += 1;
    }
    return (2 * common) / (lenA + lenB);
}

/**
 * 造一个「这段是不是已经在记忆文件里」的判定器。
 *
 * 记忆行只算一次（分词结果缓存在闭包里），召回每轮拿新查询时只花 chunk 侧的分词；
 * 长度上限先剪枝：Dice 的上界是 `2·min(|A|,|B|)/(|A|+|B|)`，长度差太多根本过不了阈值。
 *
 * @param {string[]} memoryTexts 已经剔过失效条目的记忆正文（FACT.md / 项目 MEMORY.md）。
 * @param {{ threshold?: number, minLineChars?: number }} [options]
 * @returns {(text: string) => { line: string, memoryLine: string, dice: number } | null}
 */
export function createMemoryDeduper(memoryTexts, options = {}) {
    const threshold = clamp01(options.threshold ?? DEFAULT_DICE_THRESHOLD);
    const minLineChars = Math.max(1, Math.trunc(options.minLineChars ?? DEFAULT_MIN_LINE_CHARS));

    const rows = [];
    for (const text of Array.isArray(memoryTexts) ? memoryTexts : []) {
        for (const line of splitDedupeLines(text)) {
            if (line.length < minLineChars) continue;
            const tokens = tokenize(line);
            if (tokens.length === 0) continue;
            rows.push({ line, tokens });
        }
    }

    const entireKeys = rows.map((row) => row.line.toLowerCase());

    return (text) => {
        const source = String(text ?? '').trim();
        if (source === '') return null;

        // 确定性兜底：整段 chunk 原文被某条记忆行包含（旧行为，原样抄写能秒判）。
        if (source.length >= minLineChars) {
            const lowered = source.toLowerCase();
            if (entireKeys.some((key) => key.includes(lowered))) {
                return { line: source, memoryLine: '', dice: 1 };
            }
        }

        if (threshold <= 0 || rows.length === 0) return null;

        for (const line of splitDedupeLines(source)) {
            if (line.length < minLineChars) continue;
            const tokens = tokenize(line);
            if (tokens.length === 0) continue;
            for (const row of rows) {
                const upper = (2 * Math.min(tokens.length, row.tokens.length))
                    / (tokens.length + row.tokens.length);
                if (upper < threshold) continue;
                const dice = diceCoefficient(tokens, row.tokens);
                if (dice >= threshold) return { line, memoryLine: row.line, dice };
            }
        }
        return null;
    };
}

function clamp01(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DICE_THRESHOLD;
    return Math.min(1, Math.max(0, value));
}
