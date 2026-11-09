/**
 * 召回质量离线评测：相关性排序 vs 时间倒序 / 子串匹配。
 *
 * 为什么要有单独的评测文件：单元测试只证明「机制对」（阈值、预算、去重），
 * 不证明「排序好」。这里用固定语料 + 一组改写过的自然语言查询，量化两件事：
 *  1. 同一批语料换三种检索策略，top-3 命中率差多少（子串/时间倒序是旧行为）；
 *  2. 真实 JOURNAL 片段（只读，不改文件）当噪声时，排序还稳不稳。
 *
 * 语料分两层：
 *  - **构造语料**：与项目真实结论同题材，但每条带唯一 ts、主题互不重叠，
 *    因此断言与时间无关、可复现，不依赖网络和模型。
 *  - **真实日志**：只读 `$DSH_HOME/memory/JOURNAL.jsonl`，取尾部若干条当
 *    额外语料；查询用「从该条目正文里自动截取的短语」，所以日志变了也照样能跑。
 *
 * 跑法：node test/recall-eval.test.mjs
 * 自选日志：DSH_RECALL_EVAL_JOURNAL=/path/to/JOURNAL.jsonl node test/recall-eval.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournalStore } from '../lib/journal.js';
import { readMemoryTexts } from '../lib/memory.js';
import { recall } from '../lib/recall.js';
import { normalize, tokenize } from '../lib/tokenize.js';

const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-eval-'));

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

/**
 * 构造语料：12 条，主题两两不重叠，ts 唯一且跨度一个月（让时间倒序基线有戏可唱）。
 * 每条都写成「结论式」短句，模仿真实 MEMORY.md/JOURNAL 的口径。
 */
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

/**
 * 干扰条目：和 12 条目标共享「插件 / 记忆 / 召回 / 日志 / 预算 / 备份」这类高频词，
 * 但讲的是另一件事，且时间更新。真实日志里这类近邻最多，它们正是「时间倒序」
 * 与「子串匹配」会优先选中、而相关性排序应该压下去的东西。
 */
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

/** 建索引与算基线都用这份：目标 + 干扰。 */
const CORPUS = [...SYNTHETIC, ...DISTRACTORS];

/**
 * 12 条查询：全部是改写过的自然语言（不照抄正文），因此「整句子串匹配」基本必败，
 * 这正是旧 searchJournal 的毛病（搜「写入侧」搜不到「写侧」）。每条都给出期望条目。
 */
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

/* ── 语料落盘 + 建快照 ─────────────────────────────────────────────── */

function writeCorpus(name, entries) {
    const file = join(home, `${name}.jsonl`);
    writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    return file;
}

function snapshotOf(name, entries) {
    return createJournalStore({
        file: writeCorpus(name, entries),
        scanEntries: 500,
        chunkChars: 300,
        maxChunksPerEntry: 12,
    }).snapshot();
}

/** 命中里期望条目排第几（1 起）；没命中返回 null。 */
function rankOf(result, ts) {
    const index = result.hits.findIndex((hit) => hit.ts === ts);
    return index < 0 ? null : index + 1;
}

function byTimeDesc(entries, count) {
    return [...entries].sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts)).slice(0, count);
}

/** 旧行为 1：整句 `includes()` 子串匹配（searchJournal 的老实现），命中后按时间倒序。 */
function substringTop(entries, query, count) {
    const needle = normalize(query);
    return byTimeDesc(entries.filter((entry) => normalize(entry.text).includes(needle)), count);
}

/** 旧行为 2：词级子串（只要查询的任一 token 出现在正文里就算），同样不做排序。 */
function tokenSubstringTop(entries, query, count) {
    const needles = tokenize(query).filter((token) => token.length >= 2);
    return byTimeDesc(entries.filter((entry) => {
        const text = normalize(entry.text);
        return needles.some((needle) => text.includes(needle));
    }), count);
}

function containsTs(entries, ts) {
    return entries.some((entry) => entry.ts === ts);
}

/* ══ 1. 构造语料上的排序质量：12 条查询逐条断言 top-3 命中 ══ */
const corpusSnapshot = snapshotOf('corpus', CORPUS);
/** 时间倒序基线与查询无关，循环外算一次。 */
const newestTop = byTimeDesc(CORPUS, 3);
const rows = [];
let rankedHits = 0;
let topOneHits = 0;
let timeHits = 0;
let substringHits = 0;
let tokenHits = 0;

for (const { query, expect } of QUERIES) {
    const result = recall({ snapshot: corpusSnapshot, query, config: EVAL_CONFIG });
    assert.equal(result.reason, 'ok', `查询应有命中：${query}`);

    const rank = rankOf(result, expect);
    if (rank !== null && rank <= 3) rankedHits += 1;
    if (rank === 1) topOneHits += 1;

    const wholeTop = substringTop(CORPUS, query, 3);
    const tokenTop = tokenSubstringTop(CORPUS, query, 3);
    if (containsTs(newestTop, expect)) timeHits += 1;
    if (containsTs(wholeTop, expect)) substringHits += 1;
    if (containsTs(tokenTop, expect)) tokenHits += 1;

    rows.push({
        query,
        expect: expect.slice(11, 16),
        rank,
        time: containsTs(newestTop, expect),
        whole: containsTs(wholeTop, expect),
        token: containsTs(tokenTop, expect),
    });

    assert.ok(rank !== null && rank <= 3, `「${query}」期望条目应进 top-3（实际第 ${String(rank)} 名）`);
    // 同一条日志最多占一行：一段长日志切出多段时，不能靠「同一段话重复三次」挤满名额。
    const stamps = result.hits.map((hit) => hit.ts);
    assert.equal(new Set(stamps).size, stamps.length, `命中里不应出现同一条日志的多个片段：${query}`);
}

const pad = (text, width) => {
    // CJK 在终端占两格，这里只做粗对齐，不追求像素级。
    const visual = [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
    return `${text}${' '.repeat(Math.max(0, width - visual))}`;
};

console.log('\n── 排序对比（构造语料，12 条查询）─────────────────────────────');
console.log(`${pad('查询', 34)}${pad('期望', 8)}${pad('BM25', 8)}${pad('时间倒序', 10)}${pad('整句子串', 10)}词子串`);
for (const row of rows) {
    console.log(
        `${pad(row.query, 34)}${pad(row.expect, 8)}${pad(row.rank === null ? 'miss' : `#${row.rank}`, 8)}`
        + `${pad(row.time ? '✓' : '✗', 10)}${pad(row.whole ? '✓' : '✗', 10)}${row.token ? '✓' : '✗'}`,
    );
}
const total = QUERIES.length;
console.log(
    `\n相关性排序 top-3 ${rankedHits}/${total}（其中第 1 名 ${topOneHits}/${total}）；`
    + `时间倒序 ${timeHits}/${total}；整句子串 ${substringHits}/${total}；词子串 ${tokenHits}/${total}`,
);

assert.equal(rankedHits, total, `相关性排序应全部进 top-3（实际 ${rankedHits}/${total}）`);
assert.ok(
    rankedHits > timeHits,
    `相关性排序必须优于时间倒序（${rankedHits} vs ${timeHits}）`,
);
assert.ok(
    rankedHits > substringHits,
    `相关性排序必须优于整句子串匹配（${rankedHits} vs ${substringHits}）`,
);
assert.ok(
    rankedHits > tokenHits,
    `相关性排序必须优于词级子串匹配（${rankedHits} vs ${tokenHits}）`,
);

/* ══ 2. 长条目多片段：同一条日志只贡献一行，名额留给别的条目 ══ */
{
    const phrase = '配额校验';
    // 每段约 170 字、段间用换行分隔：单段进得去一个 chunk，两段拼起来超过 300 字，
    // 于是这条长日志会被切成 3 段且**每段都含查询词**（真实日志里的长条目就是这样）。
    const filler = '剩余总额减去前言与标签之后才是正文额度，这一步必须在渲染前算清楚，'
        + '免得把半条正文写进注入块，也不能让前言把正文挤没，';
    const paragraph = (index) => `${phrase}第 ${index} 段：${filler}${filler}${filler}`;
    const longEntry = {
        ts: '2026-11-09T07:00:00.000Z',
        tags: ['recall', 'budget'],
        text: [paragraph(1), paragraph(2), paragraph(3)].join('\n'),
    };
    const otherEntry = {
        ts: '2026-11-09T06:00:00.000Z',
        tags: ['recall', 'budget'],
        text: `${phrase}的另一个来源：单条上限按标签加正文加截断后缀一起算，超了就用引流后缀收尾。`,
    };
    const chunks = snapshotOf('long-entry', [longEntry, otherEntry]);
    assert.ok(chunks.chunks.length >= 4, `长条目应被切成多段（实际 ${chunks.chunks.length} 段）`);

    // 这份语料只有 4 个片段，BM25 的 IDF 天然偏低，绝对门槛会先把长片段筛掉、
    // 掩盖「重复占位」这个要测的问题；这里只放低门槛，排序逻辑不变。
    const result = recall({ snapshot: chunks, query: '配额校验怎么算', config: { ...EVAL_CONFIG, minScore: 0.05 } });
    assert.equal(result.reason, 'ok');
    const fromLong = result.hits.filter((hit) => hit.ts === longEntry.ts);
    assert.equal(fromLong.length, 1, `同一条长日志只应占一行（实际 ${fromLong.length} 行）`);
    assert.equal(result.hits.length, 2, '另一条独立日志应该还能进来（总量 2 条）');
    assert.ok(result.text.length <= EVAL_CONFIG.maxTotalChars);
}

/* ══ 3. 失效条目不得挡住召回：过滤后的记忆文本才参与去重与预算 ══ */
{
    const conclusion = '冷门结论：召回预算的总额口径是 600 字符。';
    const previousHome = process.env.DSH_HOME;
    const fakeHome = join(home, 'fake-home');
    const work = join(fakeHome, 'work');
    mkdirSync(join(fakeHome, 'memory'), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(
        join(fakeHome, 'memory', 'FACT.md'),
        [
            '# FACT.md',
            '',
            '## 长期约定',
            `- ${conclusion} <!-- memory-state: status=superseded by=c0ffee since=2026-11-09 -->`,
            '',
        ].join('\n'),
        'utf8',
    );

    const store = createJournalStore({
        file: writeCorpus('memory-dedupe', [{ ts: '2026-11-09T05:00:00.000Z', tags: ['recall'], text: conclusion }]),
        scanEntries: 500,
        chunkChars: 300,
        maxChunksPerEntry: 12,
    });

    process.env.DSH_HOME = fakeHome;
    try {
        const filtered = readMemoryTexts(work);
        assert.ok(!filtered.join('\n').includes(conclusion), '失效条目必须被过滤掉');

        const withFiltered = recall({
            snapshot: store.snapshot(),
            query: '召回预算总额口径',
            config: EVAL_CONFIG,
            memoryTexts: filtered,
        });
        assert.equal(withFiltered.reason, 'ok', '失效条目不该挡住这条日志的召回');
        assert.ok(withFiltered.hits.length >= 1, '应命中被失效结论覆盖的日志');
        assert.ok(
            withFiltered.text.length <= EVAL_CONFIG.maxTotalChars,
            '过滤后的记忆文本不参与注入，也不占正文预算',
        );

        // 反向证明：如果拿未过滤的原文去去重，同样的召回会被整条挡掉（就是修掉的那个 bug）。
        const withoutFilter = recall({
            snapshot: store.snapshot(),
            query: '召回预算总额口径',
            config: EVAL_CONFIG,
            memoryTexts: [readFileSync(join(fakeHome, 'memory', 'FACT.md'), 'utf8')],
        });
        assert.equal(withoutFilter.text, null, '未过滤时该日志会被失效条目挡住（说明过滤是必要的）');
    } finally {
        if (previousHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previousHome;
    }
}

/* ══ 4. 真实 JOURNAL 片段（只读）当额外语料：日志变了也能跑 ══ */
{
    const configured = process.env.DSH_RECALL_EVAL_JOURNAL;
    const defaultFile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memory', 'JOURNAL.jsonl');
    const file = configured ?? defaultFile;

    if (!existsSync(file)) {
        console.log(`\n（跳过真实日志部分：没有 ${file}）`);
    } else {
        const realEntries = [];
        for (const line of readFileSync(file, 'utf8').split('\n')) {
            if (line.trim() === '') continue;
            try {
                const record = JSON.parse(line);
                if (typeof record?.text !== 'string' || record.text.trim() === '') continue;
                realEntries.push({
                    ts: typeof record.ts === 'string' ? record.ts : '',
                    tags: Array.isArray(record.tags) ? record.tags.filter((tag) => typeof tag === 'string') : [],
                    text: record.text.trim(),
                });
            } catch {
                /* 坏行跳过：评测不该因为一行脏数据红掉 */
            }
        }
        const tail = realEntries.slice(-8);
        console.log(`\n── 真实日志（只读，尾部 ${tail.length} 条当额外语料）──────────────────`);

        if (tail.length === 0) {
            console.log('（跳过：日志里没有可用条目）');
        } else {
            const snapshot = snapshotOf('with-real', [...CORPUS, ...tail]);
            for (const entry of tail) {
                // 从正文里自动取一段短语当查询：日志换内容也不影响可复现性。
                const phrase = (entry.text.match(/[\u4e00-\u9fff]{8,}/u) ?? [])[0];
                if (phrase === undefined) continue;
                const query = phrase.slice(0, 14);
                const result = recall({ snapshot, query, config: EVAL_CONFIG });
                const rank = rankOf(result, entry.ts);
                const stamps = result.hits.map((hit) => hit.ts);
                assert.equal(new Set(stamps).size, stamps.length, '真实日志也不应让同一条重复占位');
                assert.ok(
                    rank !== null && rank <= 3,
                    `真实日志查询「${query}」应命中自己的条目（实际第 ${String(rank)} 名）`,
                );
                console.log(
                    `${pad(query, 34)}${pad(entry.ts.slice(0, 10), 12)}`
                    + `${pad(rank === null ? 'miss' : `#${rank}`, 6)}${entry.tags.slice(0, 2).join(',')}`,
                );
            }

            // 现实查询（不是从正文截的短语）：真实日志里「写侧故障」会同时命中同一条的
            // 2 段，修复前会白占两行预算；这里断言「一条日志最多一行」。日志换了内容
            // 时命中数会变，所以只在真有命中时断言，不写死条数。
            const realistic = '写侧故障超时输出上限';
            const probe = recall({ snapshot, query: realistic, config: EVAL_CONFIG });
            if (probe.reason === 'ok') {
                const stamps = probe.hits.map((hit) => hit.ts);
                assert.equal(
                    new Set(stamps).size,
                    stamps.length,
                    `现实查询「${realistic}」不应让同一条日志重复占位`,
                );
                console.log(
                    `${pad(realistic, 34)}${pad('—', 12)}${pad('—', 6)}`
                    + `命中 ${stamps.length} 行 / ${new Set(stamps).size} 篇（同一条最多 1 行）`,
                );
            }
        }
    }
}

rmSync(home, { recursive: true, force: true });
console.log('\n✓ recall-eval.test.mjs 全部通过');
