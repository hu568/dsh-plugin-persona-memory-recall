/**
 * 设置页回归：把本插件注册到父插件的「记忆」页。
 *
 * 覆盖：
 *  - `ctx.get('personaMemory')` 已就绪 → 立即注册；
 *  - 未就绪但 `ctx.inject` 可用 → 服务出现后补注册；
 *  - 两者都没有 → 静默跳过，召回照常工作；
 *  - 页面回写 → 校验 → 落盘 `memory/recall.json` → 应用到运行时 config；
 *  - 非法值抛错且不落盘；覆盖层坏值回落到组合配置；
 *  - 卸载时设置项从页面撤掉；`scanEntries` 改动会重配索引缓存。
 *
 * 跑法：node test/settings.test.mjs
 * 想测 profile 里已安装的那份：设 PERSONA_MEMORY_RECALL_ENTRY=file:///…/lib/index.js
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRY = process.env.PERSONA_MEMORY_RECALL_ENTRY ?? new URL('../lib/index.js', import.meta.url).href;
const SETTINGS_ENTRY = ENTRY.replace(/index\.js$/, 'settings.js');

const home = mkdtempSync(join(tmpdir(), 'persona-memory-recall-settings-'));
process.env.DSH_HOME = home;

const mod = await import(ENTRY);
const settings = await import(SETTINGS_ENTRY);

const journal = join(home, 'memory', 'JOURNAL.jsonl');
mkdirSync(join(home, 'memory'), { recursive: true });
writeFileSync(
    journal,
    `${[
        { ts: '2026-10-30T01:30:21.036Z', tags: ['dsh'], text: '薄壳模式：在宿主层短路 llm/stream。' },
        { ts: '2026-10-29T01:30:21.036Z', tags: ['ui'], text: '右侧栏面板改用注入样式表。' },
        { ts: '2026-10-28T01:30:21.036Z', tags: ['log'], text: 'JOURNAL.jsonl 只写不召回。' },
    ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    'utf8',
);
writeFileSync(join(home, 'memory', 'FACT.md'), '# 全局\n', 'utf8');

const overridesFile = settings.recallOverridesPath();
assert.equal(overridesFile, join(home, 'memory', 'recall.json'), '覆盖层应落在 $DSH_HOME/memory/recall.json');

/* ── 假父插件：尽可能贴近 settingsRegistry 的合同 ─────────────────────── */
function makePersonaMemory() {
    const items = new Map();
    const service = {
        version: 1,
        settings: {
            register(item) {
                if (items.has(item.id)) throw new Error(`设置项 id 重复：${item.id}`);
                const entry = { ...item };
                items.set(item.id, entry);
                return {
                    id: entry.id,
                    get: () => entry.value,
                    async set(value) {
                        if (typeof entry.onChange === 'function') await entry.onChange(value);
                        entry.value = value;
                        return value;
                    },
                    update(patch) {
                        Object.assign(entry, patch);
                    },
                    dispose() {
                        items.delete(entry.id);
                    },
                };
            },
            list: () => [...items.values()],
            has: (id) => items.has(id),
            async set(id, value) {
                const entry = items.get(id);
                if (entry === undefined) throw new Error(`未知的设置项：${id}`);
                if (entry.kind === 'readonly') throw new Error(`设置项 ${id} 是只读的`);
                if (typeof entry.onChange === 'function') await entry.onChange(value);
                entry.value = value;
                return entry.value;
            },
        },
    };
    return { service, items };
}

/** 假宿主面：可记录 effect 的 disposer，也可模拟服务未就绪。 */
function makeCtx(options = {}) {
    const effects = [];
    const services = options.services ?? {};
    const ctx = {
        logger: { info() {}, warn() {} },
        on() {},
        effect(fn) {
            const dispose = fn();
            effects.push(dispose);
            return dispose;
        },
        get(key) {
            if (options.deferServices === true) return undefined;
            return services[key];
        },
        inject(deps, callback) {
            const scope = {
                get(key) {
                    return deps.includes(key) ? services[key] : undefined;
                },
                effect(fn) {
                    const dispose = fn();
                    effects.push(dispose);
                    return dispose;
                },
            };
            callback(scope);
        },
    };
    return { ctx, effects };
}

const itemOf = (items, key) => {
    const found = items.get(`recall.${key}`);
    assert.ok(found, `缺少设置项 recall.${key}`);
    return found;
};

/* ══ 1. 默认注册：键齐全、值与 config 一致、只读项指向日志文件 ══ */
{
    const pm = makePersonaMemory();
    const { ctx } = makeCtx({ services: { personaMemory: pm.service } });
    mod.apply(ctx, { journalPath: journal });

    assert.equal(pm.items.size, 10, '应注册 9 个可写项 + 1 个只读项');
    assert.equal(itemOf(pm.items, 'enabled').value, true);
    assert.equal(itemOf(pm.items, 'maxChars').value, '600');
    assert.equal(itemOf(pm.items, 'topK').value, '5');
    assert.equal(itemOf(pm.items, 'minScore').value, '1');
    assert.equal(itemOf(pm.items, 'scanEntries').value, '500');
    assert.equal(itemOf(pm.items, 'minTurnsBetween').value, '0');
    assert.equal(itemOf(pm.items, 'subagent').value, false);
    assert.equal(itemOf(pm.items, 'dedupeAgainstMemory').value, true);
    assert.equal(itemOf(pm.items, 'debug').value, false);
    assert.equal(itemOf(pm.items, 'enabled').group, '自动召回');
    assert.equal(itemOf(pm.items, 'enabled').kind, 'toggle');
    assert.equal(itemOf(pm.items, 'maxChars').group, '自动召回 · 高级', '参数项应放进高级分组');
    assert.equal(itemOf(pm.items, 'maxChars').kind, 'text');

    const readonly = pm.items.get('recall.journal');
    assert.equal(readonly.kind, 'readonly');
    assert.equal(readonly.group, '自动召回', '只读日志路径应与主开关同组');
    assert.equal(readonly.value, journal, '只读项应显示实际日志路径');
}

/* ══ 2. 回写：校验 → 落盘 → 应用到运行时 config（重新 apply 可见） ══ */
{
    const pm = makePersonaMemory();
    const { ctx } = makeCtx({ services: { personaMemory: pm.service } });
    mod.apply(ctx, { journalPath: journal });

    await pm.service.settings.set('recall.enabled', false);
    await pm.service.settings.set('recall.maxChars', '900');
    await pm.service.settings.set('recall.scanEntries', '50');

    const saved = JSON.parse(readFileSync(overridesFile, 'utf8'));
    assert.deepEqual(saved, { enabled: false, maxChars: 900, scanEntries: 50 }, '只存用户改过的键');

    // 非法值：抛错且不落盘
    await assert.rejects(
        async () => pm.service.settings.set('recall.topK', '0'),
        /不能小于 1/,
        '低于下限应拒绝',
    );
    await assert.rejects(
        async () => pm.service.settings.set('recall.maxChars', 'abc'),
        /需要一个数字/,
        '非数字应拒绝',
    );
    await assert.rejects(
        async () => pm.service.settings.set('recall.topK', '2.5'),
        /必须是整数/,
        '整数项应拒绝小数',
    );
    assert.deepEqual(
        JSON.parse(readFileSync(overridesFile, 'utf8')),
        { enabled: false, maxChars: 900, scanEntries: 50 },
        '被拒绝的回写不应改文件',
    );

    // 新进程（重新 apply）从覆盖层读回
    const again = makePersonaMemory();
    const second = makeCtx({ services: { personaMemory: again.service } });
    mod.apply(second.ctx, { journalPath: journal });
    assert.equal(itemOf(again.items, 'enabled').value, false, '总开关应从覆盖层读回');
    assert.equal(itemOf(again.items, 'maxChars').value, '900', '字符预算应从覆盖层读回');
    assert.equal(itemOf(again.items, 'scanEntries').value, '50', '索引条数应从覆盖层读回');
    assert.equal(itemOf(again.items, 'topK').value, '5', '未设过的键应回落到默认值');
}

/* ══ 3. 覆盖层坏值/坏 JSON 都当作没设过 ══ */
{
    writeFileSync(overridesFile, '{ "enabled": "no", "maxChars": 120, "topK": -1 }\n', 'utf8');
    const pm = makePersonaMemory();
    const { ctx } = makeCtx({ services: { personaMemory: pm.service } });
    mod.apply(ctx, { journalPath: journal });
    assert.equal(itemOf(pm.items, 'enabled').value, true, '类型不对的覆盖值应被丢弃');
    assert.equal(itemOf(pm.items, 'maxChars').value, '120', '合法覆盖值应保留');
    assert.equal(itemOf(pm.items, 'topK').value, '5', '越界覆盖值应被丢弃');

    writeFileSync(overridesFile, 'not json\n', 'utf8');
    const broken = makePersonaMemory();
    const brokenCtx = makeCtx({ services: { personaMemory: broken.service } });
    assert.doesNotThrow(() => mod.apply(brokenCtx.ctx, { journalPath: journal }), '坏 JSON 不应炸掉插件');
    assert.equal(itemOf(broken.items, 'enabled').value, true, '坏 JSON 应回落到默认值');
    rmSync(overridesFile, { force: true });
}

/* ══ 4. 父插件未就绪：用 ctx.inject 等服务出现后补注册 ══ */
{
    const pm = makePersonaMemory();
    const { ctx } = makeCtx({ services: { personaMemory: pm.service }, deferServices: true });
    mod.apply(ctx, { journalPath: journal });
    assert.equal(pm.items.size, 10, 'deferred get 应通过 inject 补注册');
}

/* ══ 5. 完全没有 personaMemory：静默跳过，召回监听仍在 ══ */
{
    const { ctx } = makeCtx();
    delete ctx.inject;
    assert.doesNotThrow(() => mod.apply(ctx, { journalPath: journal }), '没有父插件时不应抛错');
}

/* ══ 6. 卸载：设置项从页面撤掉 ══ */
{
    const pm = makePersonaMemory();
    const { ctx, effects } = makeCtx({ services: { personaMemory: pm.service } });
    mod.apply(ctx, { journalPath: journal });
    assert.equal(pm.items.size, 10);

    const dispose = effects[effects.length - 1];
    assert.equal(typeof dispose, 'function', '注册时应挂一个 disposer');
    dispose();
    assert.equal(pm.items.size, 0, '卸载后设置项应全部撤掉');
    dispose();
    assert.equal(pm.items.size, 0, '重复卸载不应抛错');
}

/* ══ 7. scanEntries 改动会重配索引缓存 ══ */
{
    const store = mod.createJournalStore({
        file: journal,
        scanEntries: 3,
        chunkChars: 300,
        maxChunksPerEntry: 12,
    });
    assert.equal(store.snapshot().entries.length, 3, '初始应索引全部 3 条');
    store.configure({ scanEntries: 1 });
    assert.equal(store.snapshot().entries.length, 1, '重配后应按新条数重建索引');
    store.configure({ scanEntries: 1 });
    assert.equal(store.snapshot().entries.length, 1, '相同参数不应破坏快照');
}

await assert.rejects(async () => settings.coerceSetting('unknown', true), /未知的设置项/);

rmSync(home, { recursive: true, force: true });
console.log('✓ settings.test.mjs 全部通过');
