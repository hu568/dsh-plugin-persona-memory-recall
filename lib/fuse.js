/**
 * 双通道融合：BM25 名次 + 语义名次 → 一个可排序的分。
 *
 * 为什么不直接加权求和：BM25 的分数随语料漂移（N、df 一变，同一段正文的分数就变），
 * cosine 又固定在 [-1,1]；两路分数没有可比性，人为设的权重只是把噪声搬来搬去。
 * RRF（Reciprocal Rank Fusion）只吃**名次**，天然免疫量纲，标准做法也经得起复核：
 * score = Σ weight_i / (k + rank_i)，k=60 让前几名之间的差距不至于过陡。
 *
 * 为什么只认单路出现的另一路按 Infinity：RRF 的语义就是「只在一路出现 = 另一路贡献 0」。
 * 用 Infinity 当哨兵（而不是 0）能让「有没有这一路」与「名次是多少」在输出里可分辨，
 * 排序列也直接可用。
 */

/** RRF 的标准平滑常数：k 越大，名次之间的分数差越平缓。 */
const DEFAULT_K = 60;

/** 缺省权重：两路各 1。语义通道是补漏，不该压过 BM25 的主判据。 */
const DEFAULT_WEIGHT = 1;

/** 名次哨兵：这一路没出现。 */
const ABSENT = Number.POSITIVE_INFINITY;

/** 名次表：hash → { rank, score }。同名只认第一次（列表已降序，第一次名次最好）。 */
function rankOf(list, scoreKey) {
    const ranked = new Map();
    if (!Array.isArray(list)) return ranked;
    for (let position = 0; position < list.length; position += 1) {
        const item = list[position];
        const hash = item?.hash;
        // 名次按列表位置算（含非法项），这样即使上游塞了脏数据，两路的「第 N 名」口径也不漂。
        if (typeof hash !== 'string' || hash === '') continue;
        if (ranked.has(hash)) continue;
        const raw = item[scoreKey];
        ranked.set(hash, {
            rank: position + 1,
            score: typeof raw === 'number' && Number.isFinite(raw) ? raw : 0,
        });
    }
    return ranked;
}

/** 权重解析：缺失/非法回落到 1，负数按 0（等于关掉这一路）。 */
function weightOr(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WEIGHT;
    return value < 0 ? 0 : value;
}

/**
 * RRF 融合两路召回。
 *
 * @param {{
 *   bm25?: { hash: string, score: number }[],
 *   semantic?: { hash: string, similarity: number }[],
 *   weights?: { bm25?: number, semantic?: number },
 *   k?: number,
 * }} options bm25 / semantic 都要求已按各自分数降序（上游 scoreIndex 与 cosine 排序都已保证）。
 * @returns {{ hash: string, score: number, bm25Rank: number, semanticRank: number, similarity: number | null }[]}
 *   按融合分降序；同分先看 BM25 名次（主判据），再看语义名次，最后按 hash 字典序保证稳定。
 */
export function reciprocalRankFusion(options = {}) {
    const k = typeof options.k === 'number' && Number.isFinite(options.k) && options.k > 0
        ? options.k
        : DEFAULT_K;
    const weightBm25 = weightOr(options.weights?.bm25);
    const weightSemantic = weightOr(options.weights?.semantic);

    const bm25Ranked = rankOf(options.bm25, 'score');
    const semanticRanked = rankOf(options.semantic, 'similarity');

    /** @type {Map<string, { hash: string, score: number, bm25Rank: number, semanticRank: number, similarity: number | null }>} */
    const merged = new Map();
    for (const [hash, item] of bm25Ranked) {
        merged.set(hash, {
            hash,
            score: 0,
            bm25Rank: item.rank,
            semanticRank: ABSENT,
            similarity: null,
        });
    }
    for (const [hash, item] of semanticRanked) {
        const existing = merged.get(hash);
        if (existing === undefined) {
            merged.set(hash, {
                hash,
                score: 0,
                bm25Rank: ABSENT,
                semanticRank: item.rank,
                similarity: item.score,
            });
            continue;
        }
        existing.semanticRank = item.rank;
        existing.similarity = item.score;
    }

    for (const entry of merged.values()) {
        if (Number.isFinite(entry.bm25Rank)) entry.score += weightBm25 / (k + entry.bm25Rank);
        if (Number.isFinite(entry.semanticRank)) entry.score += weightSemantic / (k + entry.semanticRank);
    }

    return [...merged.values()].sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (left.bm25Rank !== right.bm25Rank) return left.bm25Rank - right.bm25Rank;
        if (left.semanticRank !== right.semanticRank) return left.semanticRank - right.semanticRank;
        // 完全并列（同分同名次）时按 hash 排，保证输出稳定、测试可复现。
        return left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0;
    });
}

/**
 * 语义侧的「强度比」：相似度是门槛的几倍。
 *
 * 与 BM25 的 score / minScore 同构，好让 topK 分档（3 / 2 / 1.5 倍）对两路用同一套阈值。
 * 门槛为 0 / 缺省（等于关掉）时：命中就按「无限强」算——这与 recall.js 里
 * unit = max(1e-9, minScore) 的旧口径一致（0 门槛下任何正分都必然进最高档），
 * 而不是返回 NaN / 0 把语义命中打进最低档。
 *
 * @param {number} similarity
 * @param {number} minSimilarity
 * @returns {number}
 */
export function semanticRatio(similarity, minSimilarity) {
    const value = typeof similarity === 'number' && Number.isFinite(similarity)
        ? Math.min(1, Math.max(0, similarity))
        : 0;
    if (!(typeof minSimilarity === 'number' && Number.isFinite(minSimilarity) && minSimilarity > 0)) {
        return value > 0 ? Number.POSITIVE_INFINITY : 0;
    }
    return value / minSimilarity;
}

/**
 * 本轮命中的「强度比」：两个通道里相对门槛更强的那个。
 *
 * 为什么取 max 而不是平均：分档要回答的是「本轮有没有一条证据足够强」，两路里任何一路
 * 给出强证据都该给足名额；取平均会让「BM25 一般 + 语义极强」的同义改写被压回低档。
 * 各通道缺省（没传 / 0）按 0 算，不会因为分子缺失就变成 Infinity。
 *
 * @param {{ bm25Score?: number, minScore?: number, similarity?: number | null, minSimilarity?: number }} [hit]
 * @returns {number}
 */
export function hitStrength(hit = {}) {
    const bm25Score = typeof hit.bm25Score === 'number' && Number.isFinite(hit.bm25Score) && hit.bm25Score > 0
        ? hit.bm25Score
        : 0;
    // 只有「真的有 BM25 正分」时才可能 Infinite：minScore 为 0 表示门槛关闭，任何正分都算最强证据。
    const bm25Ratio = bm25Score <= 0
        ? 0
        : typeof hit.minScore === 'number' && Number.isFinite(hit.minScore) && hit.minScore > 0
            ? bm25Score / hit.minScore
            : Number.POSITIVE_INFINITY;
    const semanticSide = typeof hit.similarity === 'number' ? semanticRatio(hit.similarity, hit.minSimilarity) : 0;
    return Math.max(bm25Ratio, semanticSide);
}
