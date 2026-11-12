/**
 * 语义召回（RAG）在线评测：同一份语料 + 32 条查询（3 组），对比 BM25 与 RAG 的 hit@1 / hit@3。
 *
 * 为什么是「在线」评测：BM25 的口径在 recall-eval.test.mjs 里已经离线量化过，这里要回答的
 * 是另一个问题 —— 加一条 embedding 语义通道、用 RRF 融合之后，**同义改写**（「修好」vs
 * 「收尾」、「额度怎么卡」vs「预算三分法」）能不能召回得更多，同时不把 BM25 已经排对的
 * 名次弄坏。同义关系没法用规则穷举，只能真打 embedding 接口。
 *
 * 查询集分三类，分别回答三个问题（混在一起报会被「语义没参与」的轮次稀释）：
 *  1) 改写查询（常规）：BM25 本来就排得不错，RAG 不许更差（hit@1 不下降）；
 *  2) 普通查询：几乎照抄正文，BM25 必对，RAG 必须保住第 1 名（证明没把排对的名次弄坏）；
 *  3) 同义改写（BM25 必漏）：刻意避开目标实词，BM25 整条零命中，RAG 要接回 top-3。
 * 另外单独校验 candidates=0 档：语义没参与的轮次，输出必须与纯 BM25 一致，不参与「RAG 更好」的统计。
 *
 * 因此本用例是 opt-in：
 *  - 没有环境变量 SILICONFLOW_API_KEY 时直接 skip（打印提示），run-all 不联网；
 *  - 有 key 时才真调硅基流动 BAAI/bge-m3（key 只放环境变量，绝不写进仓库文件）；
 *  - 语义内核 / 宿主接线还没落地时也 skip（打印 [skip] 等联调），不把开发中途的
 *    半成品状态记成回归失败。
 *
 * 跑法：
 *   SILICONFLOW_API_KEY=sk-xxx node test/rag-eval.test.mjs
 *   SILICONFLOW_API_KEY=sk-xxx node test/run-all.mjs        # 只让这一条跑真 API
 *
 * 本机 key 在 $DSH_HOME/memory/recall-rag.json（chmod 600）。想临时导出又不想打屏：
 *   export SILICONFLOW_API_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.dsh/memory/recall-rag.json','utf8')).apiKey)")
 * 直接调接口的量级/体积/延迟基准在 TMP/rag-bench.mjs（读真 JOURNAL，不走 run-all）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournalStore } from '../lib/journal.js';
import { recall } from '../lib/recall.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(testDir, '..');

/* ── skip 与 key 判定 ───────────────────────────────────────────── */

function skip(reason) {
    console.log('');
    console.log('[skip] ' + reason);
    console.log('   → 本用例是 opt-in：没有 API key 不联网、不判失败；语义通道未落地时同样跳过。');
    process.exit(0);
}

const apiKey = process.env.SILICONFLOW_API_KEY ?? '';
if (apiKey.trim() === '') {
    skip('需要 API key（环境变量 SILICONFLOW_API_KEY 为空）');
}

const packageJson = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
if (!/^0\.(6|[7-9]|[1-9]\d)\./.test(packageJson.version)) {
    skip('语义通道未落地：recall 版本还是 ' + packageJson.version + '（契约要求 0.6.0 起）');
}

let semantic = null;
try {
    semantic = await import('../lib/semantic.js');
    await import('../lib/fuse.js');
} catch (error) {
    skip('语义内核未就绪：' + String(error.message).split('\n')[0]);
}

/* ── 语料与查询（与 test/recall-eval.test.mjs 同口径）───────────── */

const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-rag-eval-'));

/** 评测统一配置：预算放宽到能装下 5 条，评的是排序而不是预算裁剪。 */
const EVAL_CONFIG = {
    topK: 5,
    maxTotalChars: 2600,
    maxEntryChars: 400,
    minEntryChars: 40,
    minScore: 0.5,
    relativeCut: 0.35,
    recencyHalfLifeDays: 30,
    recencyWeight: 0.15,
    minQueryTokens: 2,
};

const SYNTHETIC = [
    {
        ts: '2026-11-09T09:00:00.000Z',
        tags: ['memory-system', 'release'],
        text: '记忆三件套发布：主插件 0.10.0 / recall 0.4.0 / consolidate 0.3.0，三份 tgz 打在 /root/.dsh/packages 目录，装进 web profile 后必须重启引擎才生效。',
    },
    {
        ts: '2026-11-09T08:00:00.000Z',
        tags: ['memory-system', 'consolidate'],
        text: '写侧故障链收尾：llm.stream 绕过 prepareCall 导致 NO_ROUTE，20 秒默认超时把长调用截断，maxOutputTokens 2048 又让输出被砍半；改官方 prepareCall 写法、超时提到 120 秒、输出上限提到 8192 之后，一次调用 8 条候选全部写入。',
    },
    {
        ts: '2026-11-08T14:10:00.000Z',
        tags: ['memory-system', 'workspace'],
        text: '项目记忆归属改成路径优先：先按 cwd 最长前缀匹配，再用 sessionIds 反查，都对不上的进 _unassigned；历史素材用 /memory-consolidate migrate [dry] 回填。',
    },
    {
        ts: '2026-11-08T13:44:00.000Z',
        tags: ['memory-system', 'redaction'],
        text: 'JOURNAL 写路径必须脱敏：手机号、sk- 密钥、token 值一律替换成 ⟨redacted⟩；召回读侧再做一次二次打码，防止旧日志里的明文进提示词。',
    },
    {
        ts: '2026-11-07T10:00:00.000Z',
        tags: ['recall', 'budget'],
        text: '召回预算三分法：整轮总额 600 字符、单条 240 字符、最小条 40 字符；剩余额度装不下最小条就整条丢弃，截断时要带引流后缀，绝不写半条。',
    },
    {
        ts: '2026-11-06T09:00:00.000Z',
        tags: ['recall', 'compaction'],
        text: '压缩后重注入：compaction/end 成功才落 pending-rehydrate 标记，下一轮把重建包 splice 到用户消息之前，与 BM25 召回二选一，避免同一段历史被注入两遍。',
    },
    {
        ts: '2026-11-05T08:00:00.000Z',
        tags: ['dsh', 'ui'],
        text: '侧栏滑动插件用屏幕边缘手势打开抽屉；面板样式改成注入样式表，主题色用 color-mix 从当前文字色推导。',
    },
    {
        ts: '2026-11-04T07:00:00.000Z',
        tags: ['dsh', 'install'],
        text: '插件安装不许用 link，必须实体安装：从本地 tarball 执行 dsh plugin --profile web add file:/root/.dsh/packages/xxx.tgz，避开对 GitHub 的网络依赖。',
    },
    {
        ts: '2026-11-03T06:00:00.000Z',
        tags: ['docs', 'handoff'],
        text: '交接文档和发布说明的定稿快照放 bak 目录，活文档始终在原处修改；bak 里同名文件不覆盖，多版本用时间后缀区分。',
    },
    {
        ts: '2026-11-02T05:00:00.000Z',
        tags: ['memory-system', 'gate'],
        text: '写入门控会在落盘前丢弃这些候选：空壳结论、过程描述、不足 8 字符、同批精确重复、状态断言没有时点；它抓不住换个说法的语义重复。',
    },
    {
        ts: '2026-11-01T04:00:00.000Z',
        tags: ['market', 'listing'],
        text: 'DSH 插件热度看市场安装量和 npm 下载量，不看 GitHub 星数；dsh.pub 收录的条目版本落后于仓库版本。',
    },
    {
        ts: '2026-10-31T03:00:00.000Z',
        tags: ['dsh', 'engine'],
        text: 'DSH 引擎不会热加载已经缓存的插件代码：改完插件要重启引擎；只执行 dsh plugin add 只换清单，运行中的代码不变。',
    },
];

/** 干扰项：与目标共享高频词但讲另一件事，且时间更新（时间倒序会先选它们）。 */
const DISTRACTORS = [
    {
        ts: '2026-11-09T11:20:00.000Z',
        tags: ['memory-system', 'settings'],
        text: '记忆插件的设置页回写要求先校验再落盘，写入失败要保留旧值，不能把半截配置写进文件。',
    },
    {
        ts: '2026-11-09T11:10:00.000Z',
        tags: ['recall', 'index'],
        text: '召回日志的索引缓存用 mtime 加 size 当键，文件没变就不重建索引，避免每轮重复分词。',
    },
    {
        ts: '2026-11-09T11:05:00.000Z',
        tags: ['dsh', 'market'],
        text: '插件市场审计：安装量上报是 0，npm 尚未发布，星数不能当用户数；后续再补齐上架材料。',
    },
    {
        ts: '2026-11-09T10:50:00.000Z',
        tags: ['memory-system', 'backup'],
        text: '备份分家：压缩备份进 backups 目录，条目级备份进 backups/auto，出问题按时间戳回滚。',
    },
];

/** 12 条改写查询：不照抄正文，因此「整句子串匹配」基本必败。 */
const QUERIES = [
    { query: '写侧一直失败，最后是怎么修好的', expect: SYNTHETIC[1].ts },
    { query: '装插件不想依赖 GitHub 怎么办', expect: SYNTHETIC[7].ts },
    { query: '召回注入太长，字符额度怎么卡', expect: SYNTHETIC[4].ts },
    { query: '压缩之后上下文怎么补回来', expect: SYNTHETIC[5].ts },
    { query: '项目记忆按什么规则归属到文件夹', expect: SYNTHETIC[2].ts },
    { query: '日志里的手机号和密钥怎么处理', expect: SYNTHETIC[3].ts },
    { query: '改完插件代码需要重启引擎吗', expect: SYNTHETIC[11].ts },
    { query: '门控会拦掉哪些垃圾条目', expect: SYNTHETIC[9].ts },
    { query: '热度应该看什么指标', expect: SYNTHETIC[10].ts },
    { query: '定稿快照应该放哪里', expect: SYNTHETIC[8].ts },
    { query: '三件套现在什么版本，包装在哪', expect: SYNTHETIC[0].ts },
    { query: '侧栏怎么滑出来', expect: SYNTHETIC[6].ts },
];

const CORPUS = [...SYNTHETIC, ...DISTRACTORS];
const corpusFile = join(home, 'corpus.jsonl');
writeFileSync(corpusFile, CORPUS.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
const snapshot = createJournalStore({
    file: corpusFile,
    scanEntries: 500,
    chunkChars: 300,
    maxChunksPerEntry: 12,
}).snapshot();

/**
 * 普通查询：几乎照抄正文关键词，BM25 本来就该排第 1。这一组用来证明语义融合**没有**
 * 把 BM25 已经排对的名次弄坏（Lead 要求：hit@1 不下降）。
 */
const NORMAL_QUERIES = [
    { query: '召回预算三分法', expect: SYNTHETIC[4].ts },
    { query: '插件安装 tarball 实体安装', expect: SYNTHETIC[7].ts },
    { query: '侧栏滑动插件 手势', expect: SYNTHETIC[6].ts },
    { query: 'JOURNAL 脱敏 手机号 sk- 密钥', expect: SYNTHETIC[3].ts },
    { query: 'compaction 后重建包 pending-rehydrate', expect: SYNTHETIC[5].ts },
    { query: '写入门控 空壳结论', expect: SYNTHETIC[9].ts },
    { query: '插件热度 npm 下载量', expect: SYNTHETIC[10].ts },
    { query: 'DSH 引擎 不会热加载 重启', expect: SYNTHETIC[11].ts },
];

/**
 * 同义改写（BM25 必漏）：刻意避开目标条目里的实词，模拟「换个说法提问」。
 * BM25 在这些查询上不是排得差，而是整条零命中 —— 语义通道的价值就在这一组。
 */
const HARD_QUERIES = [
    { query: '本地装的包会不会偷偷去网上拉', expect: SYNTHETIC[7].ts },
    { query: '机器重启之后旧代码还生效吗', expect: SYNTHETIC[11].ts },
    { query: '上下文被裁掉以后再补一包', expect: SYNTHETIC[5].ts },
    { query: '命令行装东西不想连外网', expect: SYNTHETIC[7].ts },
    { query: '聊天记录太长塞不下怎么办', expect: SYNTHETIC[4].ts },
    { query: '网页侧边栏用手势拉出来', expect: SYNTHETIC[6].ts },
    { query: '文档定版之后放哪个文件夹', expect: SYNTHETIC[8].ts },
    { query: 'AI 写日志老是吐垃圾怎么挡', expect: SYNTHETIC[9].ts },
    { query: '怎么判断插件有多少人在用', expect: SYNTHETIC[10].ts },
    { query: '记忆文件被谁、什么规则归到目录', expect: SYNTHETIC[2].ts },
    { query: '密钥被写进日志了怎么办', expect: SYNTHETIC[3].ts },
    { query: '一个包怎么同时给三件套发版', expect: SYNTHETIC[0].ts },
];

/** 三组一起取向量：偏移量与 queryVectors 下标严格对应。 */
const ALL_QUERIES = [...QUERIES, ...NORMAL_QUERIES, ...HARD_QUERIES];

/* ── 真 API：建向量（语料一次，查询逐条）───────────────────────── */

const client = semantic.createEmbeddingClient({ apiKey });
let corpusVectors = [];
let queryVectors = [];
try {
    corpusVectors = await client.embed(snapshot.chunks.map((chunk) => chunk.text));
    for (const item of ALL_QUERIES) {
        const [vector] = await client.embed([item.query]);
        queryVectors.push(vector);
    }
} catch (error) {
    rmSync(home, { recursive: true, force: true });
    console.error('');
    console.error('[fail] 调 embedding 接口失败：' + String(error.message).split('\n')[0]);
    console.error('   → 有 key 却调不通（网络 / 配额 / 假 key）时应让这条用例红掉，避免「静默跳过」掩盖接线问题。');
    process.exit(1);
}

const vectorByHash = new Map();
snapshot.chunks.forEach((chunk, index) => {
    if (!vectorByHash.has(chunk.hash)) vectorByHash.set(chunk.hash, corpusVectors[index]);
});
assert.equal(vectorByHash.size > 0, true, '语料应至少切出一段');
assert.equal(corpusVectors.every((vector) => vector.length === corpusVectors[0].length), true, '向量维度应一致');

/* ── 逐条对比：三组查询 × BM25 vs RAG ─────────────────────────── */

const rankOf = (result, ts) => {
    const index = result.hits.findIndex((hit) => hit.ts === ts);
    return index < 0 ? null : index + 1;
};

const hitCount = (ranks, limit) => ranks.filter((rank) => rank !== null && rank <= limit).length;

/** ② 档校验用：语义没参与时，RAG 的输出（text + 命中顺序 + reason）必须与纯 BM25 完全一致。 */
const sameSelection = (left, right) => left.reason === right.reason
    && left.text === right.text
    && left.hits.map((hit) => hit.ts).join('|') === right.hits.map((hit) => hit.ts).join('|');

const GROUPS = [
    { name: '改写查询（常规）', queries: QUERIES, offset: 0 },
    { name: '普通查询（BM25 本来就对）', queries: NORMAL_QUERIES, offset: QUERIES.length },
    { name: '同义改写（BM25 必漏）', queries: HARD_QUERIES, offset: QUERIES.length + NORMAL_QUERIES.length },
];

const rows = [];
let semanticHitsSeen = 0;
let semanticQueries = 0;
let fallbackChecked = 0;
let fallbackEqual = 0;

for (const group of GROUPS) {
    for (let index = 0; index < group.queries.length; index += 1) {
        const { query, expect } = group.queries[index];
        const vector = queryVectors[group.offset + index];

        const bm25 = recall({ snapshot, query, config: EVAL_CONFIG });
        // 同义改写组允许 BM25 整条零命中（这正是要测的场景）；另外两组必须命中。
        if (group.name === GROUPS[2].name) {
            if (bm25.reason !== 'ok') assert.equal(bm25.hits.length, 0, 'BM25 未命中时不应有 hits：' + query);
        } else {
            assert.equal(bm25.reason, 'ok', 'BM25 查询应有命中：' + query);
        }
        assert.equal(bm25.semantic, undefined, '纯 BM25 调用不应出现 semantic 字段（与 0.5.0 输出一致）');

        const rag = recall({
            snapshot,
            query,
            config: EVAL_CONFIG,
            semantic: {
                vectors: vectorByHash,
                queryVec: vector,
                minSimilarity: 0.55,
                relativeCut: 0.5,
            },
        });
        assert.equal(rag.reason, 'ok', 'RAG 查询应有命中：' + query);
        // 宿主接线没落地时 recall 会忽略 semantic 入参：这不是「RAG 无增益」，必须显式拦下。
        assert.ok(rag.semantic !== undefined, 'recall() 应消费 semantic 入参（宿主接线未落地）');
        assert.equal(typeof rag.semantic.used, 'boolean', 'semantic.used 应为布尔');
        assert.equal(typeof rag.semantic.candidates, 'number', 'semantic.candidates 应为数字（候选条数）');
        if (rag.semantic.candidates > 0) semanticQueries += 1;

        // ② 档（candidates=0）：语义没参与。这一档只验证「等价于 BM25」，不混进「RAG 更好」的统计。
        const sameAsBm25 = sameSelection(rag, bm25);
        if (rag.semantic.candidates === 0) {
            fallbackChecked += 1;
            if (sameAsBm25) fallbackEqual += 1;
        }

        if (rag.hits.some((hit) => typeof hit.similarity === 'number')) semanticHitsSeen += 1;
        assert.ok(rag.text === null || rag.text.length <= EVAL_CONFIG.maxTotalChars,
            'RAG 注入文本仍受 maxTotalChars 约束');
        const stamps = rag.hits.map((hit) => hit.ts);
        assert.equal(new Set(stamps).size, stamps.length, 'RAG 命中里同一条日志不应重复占位：' + query);

        rows.push({
            group: group.name,
            query,
            expect,
            bm25Rank: rankOf(bm25, expect),
            ragRank: rankOf(rag, expect),
            candidates: rag.semantic.candidates,
            sameAsBm25,
        });
    }
}

/* ── 报告 ─────────────────────────────────────────────────────── */

const pad = (text, width) => {
    const value = String(text);
    const visual = [...value].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
    return value + ' '.repeat(Math.max(0, width - visual));
};

console.log('');
console.log('── 语义召回对比（构造语料 16 段，' + rows.length + ' 条查询 / 3 组，模型 ' + client.model + '）──');
for (const group of GROUPS) {
    const groupRows = rows.filter((row) => row.group === group.name);
    console.log('');
    console.log(group.name + '（' + groupRows.length + ' 条）');
    console.log(pad('查询', 40) + pad('BM25', 7) + pad('RAG', 6) + pad('语义候选', 10) + '档位');
    for (const row of groupRows) {
        const cell = (rank) => (rank === null ? 'miss' : '#' + rank);
        console.log(pad(row.query, 34) + pad(cell(row.bm25Rank), 7) + pad(cell(row.ragRank), 6)
            + pad(String(row.candidates), 10) + (row.candidates > 0 ? '① 语义参与' : '② 未参与'));
    }
}

const statsOf = (groupRows) => ({
    n: groupRows.length,
    bm25At1: hitCount(groupRows.map((row) => row.bm25Rank), 1),
    bm25At3: hitCount(groupRows.map((row) => row.bm25Rank), 3),
    ragAt1: hitCount(groupRows.map((row) => row.ragRank), 1),
    ragAt3: hitCount(groupRows.map((row) => row.ragRank), 3),
});

console.log('');
console.log('分档统计（hit@1 / hit@3）：');
for (const group of GROUPS) {
    const stats = statsOf(rows.filter((row) => row.group === group.name));
    console.log(pad(group.name, 30) + 'BM25 ' + stats.bm25At1 + '/' + stats.n + ' · ' + stats.bm25At3 + '/' + stats.n
        + '   RAG ' + stats.ragAt1 + '/' + stats.n + ' · ' + stats.ragAt3 + '/' + stats.n);
}
const overall = { n: rows.length, bm25At1: hitCount(rows.map((row) => row.bm25Rank), 1), bm25At3: hitCount(rows.map((row) => row.bm25Rank), 3),
    ragAt1: hitCount(rows.map((row) => row.ragRank), 1), ragAt3: hitCount(rows.map((row) => row.ragRank), 3) };
console.log(pad('合计', 30) + 'BM25 ' + overall.bm25At1 + '/' + overall.n + ' · ' + overall.bm25At3 + '/' + overall.n
    + '   RAG ' + overall.ragAt1 + '/' + overall.n + ' · ' + overall.ragAt3 + '/' + overall.n);

const routine = statsOf(rows.filter((row) => row.group === GROUPS[0].name));
const normal = statsOf(rows.filter((row) => row.group === GROUPS[1].name));
const hard = statsOf(rows.filter((row) => row.group === GROUPS[2].name));

console.log('');
console.log('① 语义参与    ' + semanticQueries + '/' + rows.length + ' 条 candidates>0（其余 ' + fallbackChecked + ' 条走 ② 档）');
console.log('② 未参与档    ' + fallbackEqual + '/' + fallbackChecked + ' 条输出与纯 BM25 完全一致（text + 命中顺序 + reason）');
console.log('RAG 命中里带 similarity 的查询：' + semanticHitsSeen + '/' + rows.length);

assert.ok(semanticHitsSeen > 0, '至少要有查询的命中带 similarity，证明融合用了语义通道');
assert.ok(fallbackChecked >= 1, '本语料应至少有一条 candidates=0 的轮次，用来校验 ② 档');
assert.equal(fallbackEqual, fallbackChecked, 'candidates=0 时 RAG 的输出必须与纯 BM25 完全一致');

// 常规改写查询：RAG 不差于 BM25。
assert.ok(routine.ragAt3 >= routine.bm25At3,
    '常规改写：RAG hit@3 不应差于 BM25（RAG ' + routine.ragAt3 + ' vs BM25 ' + routine.bm25At3 + '）');
assert.ok(routine.ragAt1 >= routine.bm25At1,
    '常规改写：RAG hit@1 不应差于 BM25（RAG ' + routine.ragAt1 + ' vs BM25 ' + routine.bm25At1 + '）');

// 普通查询：BM25 本来就全对，RAG 必须一条都不弄丢。
assert.equal(normal.bm25At1, normal.n, '普通查询组的前提是 BM25 hit@1 全中（实际 ' + normal.bm25At1 + '/' + normal.n + '）');
assert.ok(normal.ragAt1 >= normal.bm25At1,
    '普通查询：RAG 不能把 BM25 排对的名次弄坏（RAG hit@1 ' + normal.ragAt1 + ' vs BM25 ' + normal.bm25At1 + '）');

// 同义改写（BM25 必漏）：RAG 要接回 top-3；BM25 至少要有 3 条零命中，否则这组前提不成立。
const zeroHits = rows.filter((row) => row.group === GROUPS[2].name && row.bm25Rank === null).length;
assert.ok(zeroHits >= 3, '同义改写组的前提是 BM25 至少 3 条零命中（实际 ' + zeroHits + ' 条）');
assert.ok(hard.ragAt3 > hard.bm25At3,
    '同义改写：RAG 应把 BM25 漏掉的接回来（RAG hit@3 ' + hard.ragAt3 + ' vs BM25 ' + hard.bm25At3 + '）');

// 总体：RAG 不差于 BM25。
assert.ok(overall.ragAt3 >= overall.bm25At3,
    '合计 hit@3：RAG 不应差于 BM25（RAG ' + overall.ragAt3 + ' vs BM25 ' + overall.bm25At3 + '）');
assert.ok(overall.ragAt1 >= overall.bm25At1,
    '合计 hit@1：RAG 不应差于 BM25（RAG ' + overall.ragAt1 + ' vs BM25 ' + overall.bm25At1 + '）');

rmSync(home, { recursive: true, force: true });
console.log('');
console.log('✓ rag-eval.test.mjs 通过（常规不退化、普通查询 hit@1 不掉、同义改写补回、②档等价 BM25）');
