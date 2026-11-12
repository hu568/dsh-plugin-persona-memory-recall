/**
 * 工作区隔离（ROADMAP B3）：JOURNAL 行的 cwd / workspaceId 解析 + 召回过滤 + 开关 + fail-open。
 *
 * 为什么这些断言重要：JOURNAL 是全局流水账，过去只把 cwd 用于去重、不用于过滤，
 * 「看书学习」的会话会命中工程日志（实测 3.14 分）。隔离必须做到「同项目根放行、
 * 跨项目根过滤、没有归属字段的旧行绝不丢」。
 *
 * 跑法：node test/workspace.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournalStore } from '../lib/journal.js';
import { recall } from '../lib/recall.js';
import {
    createWorkspaceMatcher,
    findProjectRoot,
    isSameWorkspace,
    normalizeWorkspacePath,
} from '../lib/workspace.js';

const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-workspace-'));
const workA = join(home, 'work-a');
const workB = join(home, 'work-b');
const subA = join(workA, 'sub');
mkdirSync(join(workA, '.git'), { recursive: true });
mkdirSync(join(workB, '.git'), { recursive: true });
mkdirSync(subA, { recursive: true });

/* 三行：两个不同项目根 + 一条没有归属字段的旧日志。 */
const entries = [
    {
        ts: '2026-11-09T00:00:00.000Z',
        tags: ['a'],
        cwd: workA,
        workspaceId: workA,
        text: '工程 A 的结论：薄壳模式短路 llm stream 降低调用次数。',
    },
    {
        ts: '2026-11-08T00:00:00.000Z',
        tags: ['b'],
        cwd: workB,
        workspaceId: workB,
        text: '工程 B 的结论：薄壳模式在面板里用注入样式表推导主题色。',
    },
    {
        ts: '2026-11-07T00:00:00.000Z',
        tags: ['old'],
        text: '旧日志没有 cwd：薄壳模式在宿主层短路，历史数据必须还能召回。',
    },
];
const file = join(home, 'JOURNAL.jsonl');
writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

/* ══ 1. 读侧解析：有字段就带出，没有就**不出现键**（不是 null） ══ */
const snapshot = createJournalStore({ file, scanEntries: 500, chunkChars: 300, maxChunksPerEntry: 12 }).snapshot();
assert.equal(snapshot.entries.length, 3);
assert.equal(snapshot.entries[0].cwd, workA, '应带出 cwd');
assert.equal(snapshot.entries[0].workspaceId, workA, '应带出 workspaceId');
assert.ok(!('cwd' in snapshot.entries[2]), '缺 cwd 的旧行不应出现 cwd 键');
assert.ok(!('workspaceId' in snapshot.entries[2]), '缺 workspaceId 的旧行不应出现该键');

/* ══ 2. 路径归一与同工作区判定 ══ */
assert.equal(normalizeWorkspacePath(workA + '/'), workA, '尾部斜杠应归一掉');
assert.equal(normalizeWorkspacePath('C:\\Work\\'), 'c:/work', 'Windows 盘符路径大小写归一');
assert.equal(isSameWorkspace(workA, subA), true, '子目录与项目根算同工作区（追溯父目录不算跨区）');
assert.equal(isSameWorkspace(workA, workB), false, '不同 .git 项目根不算同工作区');
assert.equal(findProjectRoot(subA), workA, '项目根是有 .git 的父目录');

/* ══ 3. 召回过滤：work-a 会话只召回 work-a + 无归属旧行 ══ */
const config = {
    topK: 5,
    maxTotalChars: 2000,
    maxEntryChars: 400,
    minScore: 0.1,
    relativeCut: 0,
    minQueryTokens: 2,
    recencyHalfLifeDays: 0,
    recencyWeight: 0,
};
const query = '薄壳模式短路 llm stream 样式表';
const fromA = recall({ snapshot, query, config, cwd: subA });
assert.equal(fromA.reason, 'ok');
const seen = fromA.hits.map((hit) => hit.ts);
assert.ok(seen.includes(entries[0].ts), '应召回同工作区日志');
assert.ok(seen.includes(entries[2].ts), '无 cwd 的旧行必须 fail-open 放行');
assert.ok(!seen.includes(entries[1].ts), '不应召回另一个工作区的日志');
assert.ok(fromA.filtered.workspace >= 1, '应记录被隔离的片段数');

/* ══ 4. 开关：workspaceIsolation=false 回到「全局一锅搜」 ══ */
const global = recall({ snapshot, query, config: { ...config, workspaceIsolation: false }, cwd: subA });
assert.ok(global.hits.some((hit) => hit.ts === entries[1].ts), '关掉隔离后跨区日志应可召回');

/* ══ 5. 会话没有 cwd：归属未知，一律放行（绝不能凭猜测丢数据） ══ */
const unknown = recall({ snapshot, query, config });
assert.ok(unknown.hits.length >= 2, '会话 cwd 未知时不应过滤');

/* ══ 6. 判定器边界：空对象 / workspaceId / 关掉开关 ══ */
const allow = createWorkspaceMatcher(workA);
assert.equal(allow({}), true, '无字段的旧行放行');
assert.equal(allow(undefined), true, '坏数据不报错、放行');
assert.equal(allow({ cwd: workA }), true);
assert.equal(allow({ cwd: subA }), true, '会话在项目根时，子目录写的日志也算同区');
assert.equal(allow({ cwd: workB }), false);
assert.equal(allow({ workspaceId: workA }), true, '没有 cwd 时不能凭 workspaceId 判跨区');
assert.equal(createWorkspaceMatcher(workA, { enabled: false })({ cwd: workB }), true, '关掉后不过滤');
assert.equal(createWorkspaceMatcher('')({ cwd: workB }), true, '会话无 cwd 时恒放行');

rmSync(home, { recursive: true, force: true });
console.log('✓ workspace.test.mjs 全部通过');
