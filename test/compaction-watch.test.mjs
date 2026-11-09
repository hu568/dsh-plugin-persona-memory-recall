/**
 * 压缩标记回归：只有「成功的 compaction/end」置位、原子落盘、坏文件当空、过期清理。
 *
 * 跑法：node test/compaction-watch.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 先固定 DSH_HOME：import 后模块里的默认路径都按它算，绝不碰真实 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-watch-'));
process.env.DSH_HOME = home;

const { createCompactionWatch, isSuccessfulCompaction, PENDING_MAX_AGE_MS, pendingRehydratePath, sessionKeyOf } =
    await import('../lib/compaction-watch.js');

const file = pendingRehydratePath();
assert.equal(file, join(home, 'memory', 'recall', 'pending-rehydrate.json'), '标记文件应在 $DSH_HOME/memory/recall/');

const session = { id: 's1' };
const now = Date.parse('2026-11-09T10:00:00.000Z');

/* ══ 1. 成功的 compaction/end 置位并原子落盘 ══ */
{
    const watch = createCompactionWatch({ now: () => now });
    assert.equal(watch.size, 0, '首次启动应为空');

    assert.equal(watch.handleEvent(session, { type: 'compaction/end', data: { compactionId: 'c1', turn: 3 } }), true);
    assert.equal(watch.isPending('s1'), true);
    assert.equal(watch.marker('s1').compactedAt, now);

    assert.ok(existsSync(file), '标记应落盘');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.sessions.s1.compactedAt, now);
    const leftovers = readdirSync(join(home, 'memory', 'recall')).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '原子写不应留下 tmp 文件');
}

/* ══ 2. 失败/无关事件不置位；空串按「没有 error」处理 ══ */
{
    const watch = createCompactionWatch({ file: join(home, 'only-success.json'), now: () => now });
    assert.equal(watch.handleEvent(session, { type: 'compaction/end', data: { compactionId: 'c1', error: 'boom' } }), false);
    assert.equal(watch.handleEvent(session, { type: 'compaction/start', data: {} }), false);
    assert.equal(watch.handleEvent(session, { type: 'compaction/summary', data: {} }), false);
    assert.equal(watch.handleEvent(null, { type: 'compaction/end', data: {} }), false);
    assert.equal(watch.handleEvent({}, { type: 'compaction/end', data: {} }), false);
    assert.equal(watch.size, 0, '没有成功的 compaction/end 就不该置位');

    // 宿主成功时省略 error；空串是旧路径的等价写法，同样算成功。
    assert.equal(isSuccessfulCompaction({ type: 'compaction/end', data: { error: '' } }), true);
    assert.equal(isSuccessfulCompaction({ type: 'compaction/end', data: { error: null } }), true);
    assert.equal(isSuccessfulCompaction({ type: 'compaction/end', data: { error: 'x' } }), false);
    assert.equal(isSuccessfulCompaction({ type: 'compaction/end' }), false, '缺 data 不算成功');
}

/* ══ 3. 坏文件当空，不抛错 ══ */
{
    const broken = join(home, 'broken.json');
    writeFileSync(broken, '{ not json', 'utf8');
    let warned = 0;
    const watch = createCompactionWatch({ file: broken, now: () => now, logger: { warn() { warned += 1; } } });
    assert.equal(watch.size, 0, '坏 JSON 应被当成空表');
    assert.equal(warned, 1, '坏文件应记一条 warn（但不抛错）');

    writeFileSync(broken, JSON.stringify({ version: 99, sessions: { s1: { compactedAt: now } } }), 'utf8');
    assert.equal(createCompactionWatch({ file: broken, now: () => now }).size, 0, '版本不认识应整份丢弃');
}

/* ══ 4. 启动时清理超过 1 天的项（其余保留），并回写文件 ══ */
{
    const stale = join(home, 'stale.json');
    mkdirSync(join(home, 'memory', 'recall'), { recursive: true });
    writeFileSync(
        stale,
        JSON.stringify({
            version: 1,
            sessions: {
                old: { compactedAt: now - PENDING_MAX_AGE_MS - 1 },
                fresh: { compactedAt: now - 60_000 },
            },
        }),
        'utf8',
    );
    const watch = createCompactionWatch({ file: stale, now: () => now });
    assert.equal(watch.isPending('old'), false, '超过 1 天的标记应被清掉');
    assert.equal(watch.isPending('fresh'), true, '未过期的标记应保留');
    const saved = JSON.parse(readFileSync(stale, 'utf8'));
    assert.deepEqual(Object.keys(saved.sessions), ['fresh'], '清理后应回写文件');

    assert.equal(watch.prune(now + PENDING_MAX_AGE_MS + 120_000), 1, 'prune 应再清掉过期项');
    assert.equal(watch.size, 0);
}

/* ══ 5. clear 清内存也清文件 ══ */
{
    const clearable = join(home, 'clear.json');
    const watch = createCompactionWatch({ file: clearable, now: () => now });
    watch.handleEvent(session, { type: 'compaction/end', data: { compactionId: 'c1' } });
    assert.equal(watch.clear('s1'), true);
    assert.equal(watch.isPending('s1'), false);
    assert.equal(watch.clear('s1'), false, '重复清理应返回 false 而不是抛错');
    assert.deepEqual(JSON.parse(readFileSync(clearable, 'utf8')).sessions, {});
}

/* ══ 6. 落盘失败只记 warn，不炸调用方（内存标记仍然有效） ══ */
{
    const blocker = join(home, 'not-a-dir');
    writeFileSync(blocker, 'x', 'utf8');
    let warned = '';
    const watch = createCompactionWatch({
        file: join(blocker, 'nested', 'pending.json'),
        now: () => now,
        logger: { warn(message) { warned += message; } },
    });
    assert.doesNotThrow(() => watch.mark('s9'), '落盘失败不应抛错');
    assert.equal(watch.isPending('s9'), true, '内存里的标记仍应生效');
    assert.match(warned, /落盘失败/, '应记一条 warn');
}

/* ══ 7. 会话键辅助函数 ══ */
{
    assert.equal(sessionKeyOf({ id: 'abc' }), 'abc');
    assert.equal(sessionKeyOf({ id: '' }), '');
    assert.equal(sessionKeyOf({}), '');
    assert.equal(sessionKeyOf(null), '');
}

rmSync(home, { recursive: true, force: true });
console.log('✓ compaction-watch.test.mjs 全部通过');
