/**
 * 设置页「记忆 → 自动召回」的声明式设置项 + 覆盖层持久化。
 *
 * 值存 `$DSH_HOME/memory/recall.json`，只存用户**显式改过**的键，与父插件的
 * `injection.json` 同一套语义：覆盖层优先，没设过的键回落到组合配置
 * （`cordis.patch.yml` 里的 config）。
 *
 * 页面只负责渲染与回写；校验、落盘、把值应用到运行时 config 全在这里。
 * 回写失败必须抛错：父插件的注册表会保留页面旧值并显示错误，不会出现
 * 「页面显示 true、实际还是 false」的分叉。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 覆盖层文件名（与父插件 `injection.json` 并列）。 */
const SETTINGS_FILE = 'recall.json';

/** 设置页的分组标题。 */
export const SETTINGS_GROUP = '自动召回';

/** 覆盖层路径：`$DSH_HOME/memory/recall.json`。 */
export function recallOverridesPath() {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(home, 'memory', SETTINGS_FILE);
}

/**
 * 设置页能改的键。
 *
 * `kind` 对应页面的四种控件；`min` / `max` / `integer` 用于校验。数字项在页面上
 * 是 `text`（宿主没有 number 控件），所以回写时是字符串，由 `coerceSetting()` 解析。
 */
export const SETTINGS_SPECS = [
    {
        key: 'enabled',
        kind: 'toggle',
        title: '每轮自动召回',
        description: '按本轮用户消息检索 JOURNAL.jsonl，命中就追加一条上下文快照。',
        order: 10,
    },
    {
        key: 'maxChars',
        kind: 'text',
        title: '每轮字符预算',
        description: '本轮召回内容的字符上限（只算命中行，不含标签与提示语）。',
        min: 80,
        integer: true,
        order: 20,
    },
    {
        key: 'topK',
        kind: 'text',
        title: '最多命中段数',
        description: '一轮最多注入几段日志。',
        min: 1,
        integer: true,
        order: 30,
    },
    {
        key: 'minScore',
        kind: 'text',
        title: '分数门槛',
        description: 'BM25 绝对分低于该值不召回；调高更保守。',
        min: 0,
        order: 40,
    },
    {
        key: 'scanEntries',
        kind: 'text',
        title: '索引日志条数',
        description: '只索引日志尾部 N 条；改大能召回更早的笔记，代价是建索引更慢。',
        min: 1,
        integer: true,
        order: 50,
    },
    {
        key: 'minTurnsBetween',
        kind: 'text',
        title: '两次注入最小间隔',
        description: '至少隔几轮才允许再次注入；0 = 换了查询就注。',
        min: 0,
        integer: true,
        order: 60,
    },
    {
        key: 'subagent',
        kind: 'toggle',
        title: '子代理也召回',
        description: '默认关闭：子代理只拿父插件给的项目记忆。',
        order: 70,
    },
    {
        key: 'dedupeAgainstMemory',
        kind: 'toggle',
        title: '与记忆文件去重',
        description: '命中片段已出现在 FACT.md / 项目 MEMORY.md 时就不再注入。',
        order: 80,
    },
    {
        key: 'debug',
        kind: 'toggle',
        title: '诊断日志',
        description: '把每轮注入或跳过的原因写进宿主日志。',
        order: 90,
    },
];

const SPEC_BY_KEY = new Map(SETTINGS_SPECS.map((spec) => [spec.key, spec]));

/**
 * 把页面的原始值转成该键的合法值。
 *
 * 不合法直接抛错（页面保留旧值并显示原因），绝不静默修正——静默修正会让
 * 用户以为写进去了，实际生效的是另一个数。
 *
 * @param {string} key
 * @param {unknown} raw
 * @returns {boolean | number}
 */
export function coerceSetting(key, raw) {
    const spec = SPEC_BY_KEY.get(key);
    if (spec === undefined) throw new Error(`未知的设置项：${key}`);

    if (spec.kind === 'toggle') {
        if (typeof raw !== 'boolean') throw new Error(`「${spec.title}」只接受开/关`);
        return raw;
    }

    let value;
    if (typeof raw === 'number') {
        value = raw;
    } else if (typeof raw === 'string' && raw.trim() !== '') {
        value = Number(raw.trim());
    } else {
        throw new Error(`「${spec.title}」需要一个数字`);
    }
    if (!Number.isFinite(value)) throw new Error(`「${spec.title}」需要一个数字`);
    if (spec.integer && !Number.isInteger(value)) throw new Error(`「${spec.title}」必须是整数`);
    if (value < spec.min) throw new Error(`「${spec.title}」不能小于 ${spec.min}`);
    if (spec.max !== undefined && value > spec.max) throw new Error(`「${spec.title}」不能大于 ${spec.max}`);
    return value;
}

/**
 * 读覆盖层。文件不存在 / 坏 JSON / 类型不对都当作「没设过」：
 * 一次手改文件不该让整个插件炸掉。
 *
 * @param {string} [file]
 * @returns {Record<string, boolean | number>}
 */
export function readRecallOverrides(file = recallOverridesPath()) {
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        return {};
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const out = {};
    for (const spec of SETTINGS_SPECS) {
        if (!Object.prototype.hasOwnProperty.call(parsed, spec.key)) continue;
        try {
            out[spec.key] = coerceSetting(spec.key, parsed[spec.key]);
        } catch {
            /* 坏值跳过，回落到组合配置 */
        }
    }
    return out;
}

/**
 * 整份写入覆盖层（原子替换）。
 *
 * @param {Record<string, boolean | number>} overrides
 * @param {string} [file]
 */
export function writeRecallOverrides(overrides, file = recallOverridesPath()) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
}

/**
 * 把覆盖层合并进运行时 config（原地修改，监听器持有同一个对象引用）。
 *
 * @param {Record<string, any>} config
 * @param {Record<string, boolean | number>} overrides
 * @returns {Record<string, any>}
 */
export function applyRecallOverrides(config, overrides) {
    for (const [key, value] of Object.entries(overrides ?? {})) {
        if (!SPEC_BY_KEY.has(key)) continue;
        config[key] = value;
    }
    return config;
}

/**
 * 造设置项。值从运行时 config 现取，`onChange` 由宿主入口提供。
 *
 * @param {{
 *   config: Record<string, any>,
 *   journalPath: string,
 *   onChange: (key: string, value: unknown) => void | Promise<void>,
 * }} options
 * @returns {Array<Record<string, any>>}
 */
export function createSettingItems(options) {
    const { config, journalPath, onChange } = options;

    const items = SETTINGS_SPECS.map((spec) => ({
        id: `recall.${spec.key}`,
        group: SETTINGS_GROUP,
        title: spec.title,
        description: spec.description,
        kind: spec.kind,
        order: spec.order,
        value: spec.kind === 'toggle' ? config[spec.key] === true : String(config[spec.key]),
        onChange: (value) => onChange(spec.key, value),
    }));

    items.push({
        id: 'recall.journal',
        group: SETTINGS_GROUP,
        title: '日志文件',
        description: '只读：召回只读这个文件，不写日志。',
        kind: 'readonly',
        order: 100,
        value: journalPath,
    });

    return items;
}
