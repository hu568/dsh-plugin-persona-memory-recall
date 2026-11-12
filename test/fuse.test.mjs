/**
 * 融合层测试：RRF 名次分（手算校验）、单路、并列排序、semanticRatio / hitStrength。
 *
 * 为什么用「手算值 + 容差」而不是快照：RRF 的公式就一个 Σ w/(k+rank)，能算出来的
 * 数字就该直接钉死；快照看不出公式写错（比如把 rank 从 0 开始、k 用成了 60.5）。
 *
 * 跑法：node test/fuse.test.mjs
 */

import assert from 'node:assert/strict';
import { hitStrength, reciprocalRankFusion, semanticRatio } from '../lib/fuse.js';

/** RRF 手算基准：k=60 时第 1/2/3 名各自的贡献。 */
const RRF = {
    rank1: 1 / (60 + 1),
    rank2: 1 / (60 + 2),
    rank3: 1 / (60 + 3),
};

/** 浮点比较：只关心「有没有按公式算」，用 1e-12 的容差。 */
function closeTo(actual, expected, label) {
    assert.ok(Math.abs(actual - expected) < 1e-12, label + '：期望 ' + expected + '，实际 ' + actual);
}

/* ══ 1. RRF 手算：两路交叉命中，顺序与分数都按 Σ 1/(k+rank) ══ */
{
    const fused = reciprocalRankFusion({
        bm25: [
            { hash: 'x', score: 5 },
            { hash: 'y', score: 3 },
            { hash: 'z', score: 1 },
        ],
        semantic: [
            { hash: 'y', similarity: 0.9 },
            { hash: 'w', similarity: 0.8 },
            { hash: 'z', similarity: 0.7 },
        ],
    });

    assert.deepEqual(fused.map((item) => item.hash), ['y', 'z', 'x', 'w'], '两路都靠前的最优，单路的按名次排');
    closeTo(fused[0].score, RRF.rank2 + RRF.rank1, 'y = 1/62 + 1/61');
    closeTo(fused[1].score, RRF.rank3 + RRF.rank3, 'z = 1/63 × 2');
    closeTo(fused[2].score, RRF.rank1, 'x 只在 BM25 第 1 名');
    closeTo(fused[3].score, RRF.rank2, 'w 只在语义第 2 名');

    assert.equal(fused[0].bm25Rank, 2);
    assert.equal(fused[0].semanticRank, 1);
    assert.ok(Math.abs(fused[0].similarity - 0.9) < 1e-12, 'semantic 相似度要透传');
    assert.equal(fused[2].semanticRank, Number.POSITIVE_INFINITY, '只在一路出现的另一路名次是 Infinity');
    assert.equal(fused[2].similarity, null);
    assert.equal(fused[3].bm25Rank, Number.POSITIVE_INFINITY);
}

/* ══ 2. 单路：另一路贡献 0，顺序与单独排序一致 ══ */
{
    const bm25Only = reciprocalRankFusion({
        bm25: [{ hash: 'a', score: 9 }, { hash: 'b', score: 4 }],
        semantic: [],
    });
    assert.deepEqual(bm25Only.map((item) => item.hash), ['a', 'b']);
    closeTo(bm25Only[0].score, RRF.rank1, '单路 RRF = w/(k+rank)');
    assert.equal(bm25Only[0].similarity, null);
    assert.equal(bm25Only[0].semanticRank, Number.POSITIVE_INFINITY);

    const semanticOnly = reciprocalRankFusion({
        bm25: undefined,
        semantic: [{ hash: 's1', similarity: 0.7 }, { hash: 's2', similarity: 0.6 }],
    });
    assert.deepEqual(semanticOnly.map((item) => item.hash), ['s1', 's2']);
    closeTo(semanticOnly[0].score, RRF.rank1);
    assert.equal(semanticOnly[0].bm25Rank, Number.POSITIVE_INFINITY);
    assert.ok(Math.abs(semanticOnly[0].similarity - 0.7) < 1e-12);

    assert.deepEqual(reciprocalRankFusion({}), [], '两路都空 → 空数组');
}

/* ══ 3. 并列：同分先看 BM25 名次（主判据），再看语义名次，最后 hash 字典序 ══ */
{
    // x 只在 BM25 第 1 名，y 只在语义第 1 名 → 同为 1/61，BM25 侧优先。
    const tied = reciprocalRankFusion({
        bm25: [{ hash: 'x', score: 1 }],
        semantic: [{ hash: 'y', similarity: 0.9 }],
    });
    assert.equal(tied[0].score, tied[1].score, '两条分数应完全相等');
    assert.deepEqual(tied.map((item) => item.hash), ['x', 'y']);
    assert.equal(tied[0].bm25Rank, 1);
    assert.equal(tied[1].bm25Rank, Number.POSITIVE_INFINITY);

    // 同分同无名次（理论上不会发生）时按 hash：保证输出稳定、可复现。
    const degenerate = reciprocalRankFusion({
        bm25: [{ hash: 'b', score: 1 }],
        semantic: [{ hash: 'a', similarity: 0.9 }],
    });
    assert.deepEqual(degenerate.map((item) => item.hash), ['b', 'a'], '同分时 BM25 名次 1 胜过 Infinity');
}

/* ══ 4. 权重：0 等于关掉这一路；负值也按 0；非数字回落 1 ══ */
{
    const bm25 = [{ hash: 'a', score: 3 }, { hash: 'b', score: 2 }];
    const semantic = [{ hash: 'b', similarity: 0.8 }, { hash: 'c', similarity: 0.7 }];

    const onlySemantic = reciprocalRankFusion({ bm25, semantic, weights: { bm25: 0, semantic: 1 } });
    assert.deepEqual(onlySemantic.map((item) => item.hash), ['b', 'c', 'a']);
    closeTo(onlySemantic[0].score, RRF.rank1);
    closeTo(onlySemantic[2].score, 0, '权重 0 = 这一路没有贡献');

    const heavyBm25 = reciprocalRankFusion({ bm25, semantic, weights: { bm25: 2, semantic: 0.5 } });
    // b 两路都有（0.0405）反超了只在 BM25 第 1 名的 a（0.0328）：两路同时在列就该压过单路。
    assert.deepEqual(heavyBm25.map((item) => item.hash), ['b', 'a', 'c']);
    closeTo(heavyBm25[0].score, 2 * RRF.rank2 + 0.5 * RRF.rank1, 'b 两路都有：2 × 1/62 + 0.5 × 1/61');
    closeTo(heavyBm25[1].score, 2 * RRF.rank1, 'a 只有 BM25 第 1 名：2 × 1/61');

    const fallback = reciprocalRankFusion({ bm25, semantic, weights: { bm25: Number.NaN, semantic: -3 } });
    closeTo(fallback[0].score, RRF.rank1, '非法权重回落 1，负权重按 0');
}

/* ══ 5. k 可调：k 越小，名次差距越陡（默认 60 就是 RRF 标准值） ══ */
{
    const fused = reciprocalRankFusion({
        bm25: [{ hash: 'a', score: 2 }],
        semantic: [{ hash: 'a', similarity: 0.9 }],
        k: 1,
    });
    closeTo(fused[0].score, 1 / 2 + 1 / 2, 'k=1，两路都是第 1 名 → 1');

    const defaulted = reciprocalRankFusion({ bm25: [{ hash: 'a', score: 2 }] });
    closeTo(defaulted[0].score, RRF.rank1, '默认 k=60');

    const bogus = reciprocalRankFusion({ bm25: [{ hash: 'a', score: 2 }], k: -5 });
    closeTo(bogus[0].score, RRF.rank1, '非法 k 回落 60');
}

/* ══ 6. 脏输入：同 hash 只认第一次名次、缺 hash 的项跳过但仍占名次、非有限分数按 0 ══ */
{
    const deduped = reciprocalRankFusion({
        bm25: [{ hash: 'a', score: 9 }, { hash: 'a', score: 1 }, { hash: 'b', score: 5 }],
    });
    assert.equal(deduped.length, 2, '同 hash 不应出现两次');
    // b 的位置是第 3 项 → rank 3（名次按位置算，不因跳过而提前）。
    assert.equal(deduped.find((item) => item.hash === 'b').bm25Rank, 3);

    const dirty = reciprocalRankFusion({
        bm25: [{ hash: 'a', score: Number.NaN }, { score: 1 }, {}, null],
        semantic: [{ hash: 's', similarity: Number.POSITIVE_INFINITY }],
    });
    assert.equal(dirty.length, 2, '缺 hash 的项与 null 都被跳过');
    assert.equal(dirty.find((item) => item.hash === 's').similarity, 0, '非有限相似度按 0（脏数据不能污染排序）');
}

/* ══ 7. semanticRatio：相似度 / 门槛，门槛关闭时正相似度算「无限强」 ══ */
{
    closeTo(semanticRatio(0.8, 0.55), 0.8 / 0.55, '0.8 / 0.55');
    assert.ok(semanticRatio(0.4, 0.55) < 1, '低于门槛时 ratio < 1');
    closeTo(semanticRatio(0.4, 0.55), 0.4 / 0.55);
    assert.equal(semanticRatio(-0.2, 0.55), 0, '负相似度按 0');
    assert.equal(semanticRatio(0, 0.55), 0);
    assert.equal(semanticRatio(0.7, 0), Number.POSITIVE_INFINITY, '门槛 0 = 关闭 → 命中即最强');
    assert.equal(semanticRatio(0, 0), 0, '没有命中就没有强度');
    assert.equal(semanticRatio(0.7, -1), Number.POSITIVE_INFINITY, '负门槛视同关闭');
    assert.equal(semanticRatio(Number.NaN, 0.55), 0, 'NaN 不能传染');
    closeTo(semanticRatio(1.5, 1), 1, '大于 1 的输入先 clamp 到 1');
}

/* ══ 8. hitStrength：两路取 max（哪一路证据强就按哪一路分档） ══ */
{
    // BM25 强：3 / 1 = 3，胜过语义的 0.6 / 0.55 ≈ 1.09。
    closeTo(hitStrength({ bm25Score: 3, minScore: 1, similarity: 0.6, minSimilarity: 0.55 }), 3, 'BM25 侧更强');
    // 语义强：BM25 零分（同义改写一条都召不回）时，靠语义单独进高档。
    closeTo(hitStrength({ bm25Score: 0, minScore: 1, similarity: 0.6, minSimilarity: 0.55 }), 0.6 / 0.55, '语义侧更强');
    assert.equal(hitStrength({}), 0, '全缺省按 0');
    assert.equal(hitStrength({ similarity: null }), 0, '语义未命中也按 0');
    assert.equal(hitStrength({ bm25Score: 2, minScore: 0 }), Number.POSITIVE_INFINITY, 'minScore=0 → 任何正分都最强');
    assert.equal(hitStrength({ bm25Score: 0, minScore: 0 }), 0, '分子为 0 不因门槛关闭就变 Infinity');
    assert.equal(hitStrength({ bm25Score: Number.NaN, minScore: 1, similarity: 0.7, minSimilarity: 0.55 }), 0.7 / 0.55, 'NaN 的 BM25 分按 0 算，语义仍生效');
    assert.equal(hitStrength({ bm25Score: 1, minScore: 1, similarity: -0.5, minSimilarity: 0.55 }), 1, '负相似度不参与 max');
}

console.log('✓ fuse.test.mjs 全部通过（8 组）');
