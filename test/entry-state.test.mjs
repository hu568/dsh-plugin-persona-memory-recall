/**
 * 失效条目过滤回归（DESIGN-memory-lifecycle.md 第 1、2、7 节）。
 *
 * 召回侧为什么必须自己过滤：主插件只在渲染层不注入失效条目，文件里原文还在。
 * 如果召回继续把原文当「模型已看到的内容」去重，过时结论就会变成一堵隐形的墙 ——
 * 新日志里讲同一件事的片段被挡掉，模型两边都看不到。
 *
 * 这个包不 import 主插件源码（独立发布、独立版本），所以格式容错也各自覆盖：
 * 解析不确定时一律按 active 处理，宁可多留一条，也不能把活条目误删成不可见。
 *
 * 跑法：node test/entry-state.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEntryState, readMemoryTexts, stripInactiveEntries } from '../lib/memory.js';

/* ══ 1. 无注释 = active（老文件天然兼容，FACT.md 的 `- ` 形态） ══ */
{
    const parsed = parseEntryState('- 本机通过 git 协议访问 GitHub 会失败。');
    assert.equal(parsed.state.status, 'active');
    assert.equal(parsed.text, '- 本机通过 git 协议访问 GitHub 会失败。', '无注释时正文逐字不变');
    assert.equal(parsed.state.by, '');
    assert.equal(parsed.state.since, '');
}

/* ══ 2. 项目 MEMORY.md 的编号条目：superseded 且字段可解析 ══ */
{
    const parsed = parseEntryState('1. 记忆三件套版本 0.9.0 / 0.3.0 / 0.2.3。 <!-- memory-state: status=superseded by=9f8e7d since=2026-11-09 -->');
    assert.equal(parsed.state.status, 'superseded');
    assert.equal(parsed.state.by, '9f8e7d');
    assert.equal(parsed.state.since, '2026-11-09');
    assert.equal(parsed.text, '1. 记忆三件套版本 0.9.0 / 0.3.0 / 0.2.3。', 'text 永远是纯正文');
}

/* ══ 3. archived 同样算失效；`1)` 编号、`*` / `+` 无序条目也要认 ══ */
{
    assert.equal(
        parseEntryState('2) 旧路线 <!-- memory-state: status=archived since=2026-10-01 -->').state.status,
        'archived',
    );
    assert.equal(parseEntryState('* 星号条目 <!-- memory-state: status=superseded -->').state.status, 'superseded');
    assert.equal(parseEntryState('+ 加号条目 <!-- memory-state: status=archived -->').state.status, 'archived');
}

/* ══ 4. 容错：残缺 / 拼错 / 双注释 / 非条目行 → 一律 active，且不改写原文 ══ */
{
    const broken = '- 残缺注释 <!-- memory-state: status=superseded';
    assert.equal(parseEntryState(broken).state.status, 'active', '注释没闭合应按 active 处理');
    assert.equal(parseEntryState(broken).text, broken);

    const typo = '- 状态拼错 <!-- memory-state: status=superceded since=2026-11-09 -->';
    assert.equal(parseEntryState(typo).state.status, 'active', 'status 拼错应按 active 处理');

    const double = '- 双注释 <!-- memory-state: status=superseded --> <!-- memory-state: status=superseded -->';
    assert.equal(parseEntryState(double).state.status, 'active', '同一行多个状态注释属于格式错误');

    const heading = '## 结论 <!-- memory-state: status=superseded -->';
    assert.equal(parseEntryState(heading).state.status, 'active', '非条目行不能被当成条目');
    assert.equal(parseEntryState(heading).text, heading);

    const prose = '这是一段说明文字 <!-- memory-state: status=superseded -->';
    assert.equal(parseEntryState(prose).state.status, 'active', '段首说明不是条目');
}

/* ══ 5. 整篇剔除：只删失效条目，标题 / 空行 / 速查 / 活条目逐字节保留 ══ */
{
    const raw = [
        '# FACT.md — 全局长期记忆',
        '',
        '## 长期约定',
        '',
        '- 活条目 A',
        '- 已失效 B <!-- memory-state: status=superseded by=abc since=2026-11-09 -->',
        '- 已归档 C <!-- memory-state: status=archived since=2026-11-08 -->',
        '',
        '## 速查',
        '- 全量测试：三包各自 `node test/run-all.mjs`',
        '- 写侧体检：`node TMP/check-consolidate-run.mjs`',
        '  - 缩进的速查子项也不该被删',
        '',
        '1. 编号活条目',
        '2. 编号失效条目 <!-- memory-state: status=superseded since=2026-11-07 -->',
    ].join('\n');

    const stripped = stripInactiveEntries(raw);
    assert.ok(stripped.includes('- 活条目 A'), '活条目必须留下');
    assert.ok(!stripped.includes('已失效 B'), 'superseded 条目必须删掉');
    assert.ok(!stripped.includes('已归档 C'), 'archived 条目必须删掉');
    assert.ok(stripped.includes('## 速查'), '速查标题必须留下');
    assert.ok(stripped.includes('全量测试'), '速查正文是参考数据，不是条目状态，不能误删');
    assert.ok(stripped.includes('缩进的速查子项'), '缩进的速查子项也不能误删');
    assert.ok(stripped.includes('1. 编号活条目'), '编号活条目必须留下');
    assert.ok(!stripped.includes('2. 编号失效条目'), '编号失效条目必须删掉');
    assert.ok(stripped.split('\n').length === raw.split('\n').length - 3, '只少了 3 行，没有别的改动');
}

/* ══ 6. 幂等 + 真实文件口径：没有状态注释时逐字节不变，跑两遍结果一致 ══ */
{
    const raw = '- A <!-- memory-state: status=superseded -->\n- B\n<!-- 普通注释，不是状态 -->\n';
    const once = stripInactiveEntries(raw);
    assert.equal(stripInactiveEntries(once), once, '过滤必须幂等');
    assert.ok(once.includes('<!-- 普通注释，不是状态 -->'), '普通 HTML 注释不是状态注释');

    assert.equal(stripInactiveEntries(''), '');
    assert.equal(stripInactiveEntries('# 只有标题\n\n没有条目'), '# 只有标题\n\n没有条目');

    // CRLF 文档：行尾的 \r 不能挡住状态注释匹配。
    const crlf = '- 旧条目 <!-- memory-state: status=archived -->\r\n- 新条目\r\n';
    assert.equal(stripInactiveEntries(crlf), '- 新条目\r\n');
}

/* ══ 7. readMemoryTexts：两级记忆都过滤，且只返回过滤后的文本 ══ */
{
    const previousHome = process.env.DSH_HOME;
    const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-state-'));
    const project = join(home, 'work');
    const memoryDir = join(home, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(project, { recursive: true });

    writeFileSync(
        join(memoryDir, 'FACT.md'),
        [
            '# FACT.md',
            '',
            '## 长期约定',
            '- 活结论：写锁按目标文件统一。',
            '- 过时结论：写入不需要锁 <!-- memory-state: status=superseded by=aaaa since=2026-11-09 -->',
            '',
        ].join('\n'),
        'utf8',
    );
    writeFileSync(
        join(project, 'MEMORY.md'),
        [
            '# MEMORY.md',
            '',
            '## 结论',
            '',
            '1. 活结论：召回预算三分法 600 / 240 / 40。',
            '2. 过时结论：预算只有一档 <!-- memory-state: status=superseded by=bbbb since=2026-11-09 -->',
            '',
            '## 速查',
            '- 全量测试：`node test/run-all.mjs`',
            '',
        ].join('\n'),
        'utf8',
    );

    process.env.DSH_HOME = home;
    try {
        const texts = readMemoryTexts(project);
        assert.equal(texts.length, 2, '全局 + 项目两份都要返回');
        const joined = texts.join('\n');
        assert.ok(joined.includes('活结论：写锁按目标文件统一'), '全局活条目必须保留');
        assert.ok(joined.includes('活结论：召回预算三分法'), '项目活条目必须保留');
        assert.ok(!joined.includes('写入不需要锁'), '全局失效条目必须过滤');
        assert.ok(!joined.includes('预算只有一档'), '项目失效条目必须过滤');
        assert.ok(joined.includes('全量测试'), '项目速查段不能因为过滤被删');

        // 过滤后再取一次结果不变（不依赖文件里的状态注释被改写）。
        assert.deepEqual(readMemoryTexts(project), texts, '同一文件重复读取应稳定');
    } finally {
        if (previousHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
    }
}

console.log('✓ entry-state.test.mjs 全部通过');
