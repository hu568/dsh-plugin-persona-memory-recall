/**
 * 召回选择与渲染：打分 → 阈值 → 去重 → 预算 → 文本。
 *
 * 这一层是纯函数（输入快照与查询，输出文本），测试不需要宿主。
 */

import { scoreIndex } from './bm25.js';
import { tokenize } from './tokenize.js';

/** 单条日志最多参与打分的 query token 数（防超长粘贴）。 */
const MAX_QUERY_TOKENS = 400;

/** 与 FACT.md / 项目 MEMORY.md 去重时，片段至少要这么长才值得比。 */
const DEDUPE_MIN_CHARS = 12;

function compareKey(text) {
    return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function clip(text, maxChars) {
    const trimmed = text.trim();
    return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

function dateOf(ts) {
    return typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : '----------';
}

function tagText(tags) {
    return tags.length === 0 ? '' : ` [${tags.join(',')}]`;
}

function isAlreadyInMemory(key, memoryKeys) {
    if (key.length < DEDUPE_MIN_CHARS) return false;
    return memoryKeys.some((memory) => memory.includes(key));
}

function renderHits(lines, count) {
    return [
        `<recalled-journal source="JOURNAL.jsonl" hits="${count}">`,
        ...lines,
        '</recalled-journal>',
        '',
        '以上是按本轮消息从长期日志（JOURNAL.jsonl）自动检索到的历史笔记，已与 FACT.md / 项目 MEMORY.md 去重。',
        '它们可能过时，或只是同词不同义；当作线索而非事实。需要更多/更旧的笔记仍用 memory action=search。',
    ].join('\n');
}

/**
 * 按本轮查询召回日志片段。
 *
 * @param {{
 *   snapshot: { chunks: { entry: { ts: string, tags: string[], text: string }, text: string }[], index: any },
 *   query: string,
 *   config: any,
 *   memoryTexts?: string[],
 *   now?: number,
 * }} options
 * @returns {{ text: string | null, hits: { ts: string, tags: string[], text: string, score: number }[], reason: string, usedChars: number }}
 */
export function recall(options) {
    const { snapshot, query, config } = options;
    const memoryTexts = options.memoryTexts ?? [];
    const now = options.now ?? Date.now();

    const queryTokens = tokenize(query).slice(0, MAX_QUERY_TOKENS);
    if (queryTokens.length < config.minQueryTokens) {
        return { text: null, hits: [], reason: 'short-query', usedChars: 0 };
    }
    if (snapshot.chunks.length === 0) {
        return { text: null, hits: [], reason: 'empty-journal', usedChars: 0 };
    }

    const scored = scoreIndex(snapshot.index, queryTokens);
    if (scored.length === 0) {
        return { text: null, hits: [], reason: 'no-hit', usedChars: 0 };
    }

    const halfLife = config.recencyHalfLifeDays;
    const weight = config.recencyWeight;
    const ranked = scored
        .map(({ index, score }) => {
            const chunk = snapshot.chunks[index];
            if (halfLife <= 0 || weight <= 0) return { chunk, score };
            const timestamp = Date.parse(chunk.entry.ts);
            if (!Number.isFinite(timestamp)) return { chunk, score };
            const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
            return { chunk, score: score * (1 + weight * Math.exp(-ageDays / halfLife)) };
        })
        .sort((left, right) => right.score - left.score);

    const top = ranked[0].score;
    if (top < config.minScore) {
        return { text: null, hits: [], reason: 'below-min-score', usedChars: 0 };
    }
    const floor = Math.max(config.minScore, top * config.relativeCut);

    const memoryKeys = memoryTexts.map(compareKey).filter((text) => text !== '');
    const seen = new Set();
    const hits = [];
    const lines = [];
    let usedChars = 0;
    const budget = Math.max(40, config.maxChars);

    for (const { chunk, score } of ranked) {
        if (score < floor) break;
        if (hits.length >= config.topK) break;

        const text = clip(chunk.text, config.perChunkChars);
        const key = compareKey(text);
        if (key === '' || seen.has(key)) continue;
        seen.add(key);
        if (isAlreadyInMemory(key, memoryKeys)) continue;

        let line = `- ${dateOf(chunk.entry.ts)}${tagText(chunk.entry.tags)} ${text}`;
        if (line.length > budget) line = `${line.slice(0, budget - 1)}…`;
        if (usedChars + line.length + 1 > budget) break;

        usedChars += line.length + 1;
        hits.push({ ts: chunk.entry.ts, tags: chunk.entry.tags, text, score });
        lines.push(line);
    }

    if (hits.length === 0) {
        return { text: null, hits, reason: 'filtered', usedChars: 0 };
    }
    return { text: renderHits(lines, hits.length), hits, reason: 'ok', usedChars };
}
