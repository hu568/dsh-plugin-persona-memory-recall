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
 *
 * 0.6.0 例外：语义召回的 API Key **不进 recall.json**，单独写
 * $DSH_HOME/memory/recall-rag.json（原子写 + chmod 600）。原因：recall.json 是
 * 「页面覆盖层」，会被整篇覆盖、可能被备份/同步，key 混进去等于把密钥当配置发出去。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 覆盖层文件名（与父插件 `injection.json` 并列）。 */
const SETTINGS_FILE = 'recall.json';

/** 语义 key 侧车文件名：与 recall.json 并列，但单独存、单独 chmod。 */
const RAG_FILE = 'recall-rag.json';

/** 主分组：常用开关，始终展开。 */
export const SETTINGS_GROUP = '自动召回';
/** 高级分组：参数项，页面会按项数自动收起。 */
export const SETTINGS_ADVANCED_GROUP = '自动召回 · 高级';
/** 语义召回分组：RAG 通道自己的开关与参数（默认收起，不影响纯 BM25 用户）。 */
export const SETTINGS_SEMANTIC_GROUP = '自动召回 · 语义';

/** 覆盖层路径：`$DSH_HOME/memory/recall.json`。 */
export function recallOverridesPath() {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(home, 'memory', SETTINGS_FILE);
}

/** 语义 key 侧车路径：$DSH_HOME/memory/recall-rag.json。 */
export function ragConfigPath() {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(home, 'memory', RAG_FILE);
}

/**
 * 读语义 key 侧车。不存在 / 坏 JSON / 类型不对都当作「没配过」：手改这个文件
 * 不该让插件炸掉。返回值里绝不带日志输出（apiKey 只在内存里用）。
 *
 * @param {string} [file]
 * @returns {{ apiKey?: string, model?: string, baseURL?: string }}
 */
export function readRagConfig(file = ragConfigPath()) {
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
    for (const key of ['apiKey', 'model', 'baseURL']) {
        if (typeof parsed[key] === 'string' && parsed[key].trim() !== '') out[key] = parsed[key].trim();
    }
    return out;
}

/**
 * 原子写语义 key 侧车：同目录 tmp + rename，落盘后 chmod 600。
 *
 * 为什么单独文件而不是 recall.json：
 *  - recall.json 会被页面整篇覆盖，key 混进去迟早被别的设置回写冲掉；
 *  - 那份文件可能进备份 / git / 排障快照，key 不能出现在这些地方；
 *  - 单独文件也方便用户直接删掉来撤销 key。
 *
 * 只覆盖传进来的字段（undefined 保留旧值），所以改模型名不会把 key 冲掉。
 *
 * @param {{ apiKey?: string, model?: string, baseURL?: string }} next
 * @param {string} [file]
 * @returns {{ bytes: number, path: string }}
 */
export function writeRagConfig(next, file = ragConfigPath()) {
    const current = readRagConfig(file);
    const merged = {};
    for (const key of ['apiKey', 'model', 'baseURL']) {
        const value = typeof next?.[key] === 'string' ? next[key].trim() : '';
        const fallback = current[key] ?? '';
        const chosen = value !== '' ? value : fallback;
        if (chosen !== '') merged[key] = chosen;
    }

    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    const body = JSON.stringify(merged, null, 2) + '\n';
    // mode 直接给 600：tmp 落盘那一刻就不对组/其他用户开放，rename 不会改权限。
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    try {
        chmodSync(file, 0o600);
    } catch {
        /* 某些文件系统（如 Android 共享存储）不支持 chmod，权限位尽力而为 */
    }
    return { bytes: Buffer.byteLength(body, 'utf8'), path: file };
}

/**
 * 语义 API Key 的读取优先级（契约 v1）：config > recall-rag.json > env。
 *
 * 为什么 config 最高：组合配置是部署方显式写的，应该能压过本机文件；
 * 为什么文件压过 env：页面/文件是用户主动配置的，env 更像临时注入。
 * 空串一律当「没配」，避免把空 key 传给客户端。
 *
 * @param {Record<string, any>} [config]
 * @param {string} [file]
 * @returns {string}
 */
export function resolveSemanticApiKey(config = {}, file = ragConfigPath()) {
    const fromConfig = typeof config.semanticApiKey === 'string' ? config.semanticApiKey.trim() : '';
    if (fromConfig !== '') return fromConfig;

    const fromFile = readRagConfig(file).apiKey;
    if (typeof fromFile === 'string' && fromFile !== '') return fromFile;

    return typeof process.env.SILICONFLOW_API_KEY === 'string'
        ? process.env.SILICONFLOW_API_KEY.trim()
        : '';
}

/**
 * 设置页能改的键。
 *
 * `kind` 对应页面的四种控件；`min` / `max` / `integer` 用于校验。数字项在页面上
 * 是 `text`（宿主没有 number 控件），所以回写时是字符串，由 `coerceSetting()` 解析。
 * valueType: 'string' 表示字符串项（模型名 / API Key），不做数字校验。
 * ragOnly 表示只写语义侧车、不进 recall.json（目前只有 API Key）。
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
        group: SETTINGS_ADVANCED_GROUP,
        title: '每轮字符预算',
        description: '整轮上限：前言 + 标签 + 正文全算；小于约 210 字符时装不下任何一条，会写「预算不足，未注入」警告日志。',
        min: 80,
        integer: true,
        order: 20,
    },
    {
        key: 'topK',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: '最多命中段数',
        description: '一轮最多注入几段日志。',
        min: 1,
        integer: true,
        order: 30,
    },
    {
        key: 'minScore',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: '分数门槛',
        description: 'BM25 绝对分低于该值不召回；调高更保守。',
        min: 0,
        order: 40,
    },
    {
        key: 'scanEntries',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: '索引日志条数',
        description: '只索引日志尾部 N 条；改大能召回更早的笔记，代价是建索引更慢。',
        min: 1,
        integer: true,
        order: 50,
    },
    {
        key: 'minTurnsBetween',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: '两次注入最小间隔',
        description: '至少隔几轮才允许再次注入；0 = 换了查询就注。',
        min: 0,
        integer: true,
        order: 60,
    },
    {
        key: 'subagent',
        kind: 'toggle',
        group: SETTINGS_ADVANCED_GROUP,
        title: '子代理也召回',
        description: '默认关闭：子代理只拿父插件给的项目记忆。',
        order: 70,
    },
    {
        key: 'dedupeAgainstMemory',
        kind: 'toggle',
        group: SETTINGS_ADVANCED_GROUP,
        title: '与记忆文件去重',
        description: '命中片段已出现在 FACT.md / 项目 MEMORY.md 时就不再注入。',
        order: 80,
    },
    {
        key: 'workspaceIsolation',
        kind: 'toggle',
        group: SETTINGS_ADVANCED_GROUP,
        title: '按工作区隔离召回',
        description: '只召回当前工作区（或同一项目根）的日志；没有 cwd 的旧日志一律放行。关掉 = 全局日志一锅搜。',
        order: 85,
    },
    {
        key: 'debug',
        kind: 'toggle',
        group: SETTINGS_ADVANCED_GROUP,
        title: '诊断日志',
        description: '把每轮注入或跳过的原因写进宿主日志。',
        order: 90,
    },
    /* ── 语义召回（RAG）：默认开，但没有 API Key 时自动退回纯 BM25 ───────── */
    {
        key: 'semantic',
        kind: 'toggle',
        group: SETTINGS_SEMANTIC_GROUP,
        title: '语义召回（RAG）',
        description: '用嵌入模型补「同义改写 BM25 一条都召不回」的漏杀；没配 API Key 时自动退回纯 BM25，失败也绝不挡 turn。',
        order: 200,
    },
    {
        key: 'semanticModel',
        kind: 'text',
        valueType: 'string',
        group: SETTINGS_SEMANTIC_GROUP,
        title: '嵌入模型',
        description: '硅基流动的嵌入模型名，默认 BAAI/bge-m3（1024 维，免费）。',
        order: 210,
    },
    {
        key: 'semanticApiKey',
        kind: 'text',
        valueType: 'string',
        ragOnly: true,
        secret: true,
        group: SETTINGS_SEMANTIC_GROUP,
        title: '硅基流动 API Key',
        description: '只写本机 $DSH_HOME/memory/recall-rag.json（原子写 + chmod 600），不进 recall.json、不进仓库与安装包；页面不回显，填入新值即替换。',
        order: 220,
    },
    {
        key: 'semanticMinSimilarity',
        kind: 'text',
        group: SETTINGS_SEMANTIC_GROUP,
        title: '相似度门槛',
        description: 'cosine 相似度低于该值不算语义候选（0–1，默认 0.55）。',
        min: 0,
        max: 1,
        order: 230,
    },
    {
        key: 'semanticTimeoutMs',
        kind: 'text',
        group: SETTINGS_SEMANTIC_GROUP,
        title: '语义超时（毫秒）',
        description: '单轮语义查询超过该时间就降级为纯 BM25，不阻塞 turn（默认 4000）。',
        min: 0,
        integer: true,
        order: 240,
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
 * @returns {boolean | number | string}
 */
export function coerceSetting(key, raw) {
    const spec = SPEC_BY_KEY.get(key);
    if (spec === undefined) throw new Error('未知的设置项：' + key);

    if (spec.kind === 'toggle') {
        if (typeof raw !== 'boolean') throw new Error('「' + spec.title + '」只接受开/关');
        return raw;
    }

    if (spec.valueType === 'string') {
        if (typeof raw !== 'string') throw new Error('「' + spec.title + '」需要一个字符串');
        const value = raw.trim();
        if (value === '') {
            // 密钥项的空串有「留空 = 不改动」的语义（由宿主入口判定）；
            // 其它字符串项（模型名）不允许空。
            if (spec.secret === true) return '';
            throw new Error('「' + spec.title + '」不能为空');
        }
        return value;
    }

    let value;
    if (typeof raw === 'number') {
        value = raw;
    } else if (typeof raw === 'string' && raw.trim() !== '') {
        value = Number(raw.trim());
    } else {
        throw new Error('「' + spec.title + '」需要一个数字');
    }
    if (!Number.isFinite(value)) throw new Error('「' + spec.title + '」需要一个数字');
    if (spec.integer && !Number.isInteger(value)) throw new Error('「' + spec.title + '」必须是整数');
    if (value < spec.min) throw new Error('「' + spec.title + '」不能小于 ' + spec.min);
    if (spec.max !== undefined && value > spec.max) throw new Error('「' + spec.title + '」不能大于 ' + spec.max);
    return value;
}

/**
 * 读覆盖层。文件不存在 / 坏 JSON / 类型不对都当作「没设过」：
 * 一次手改文件不该让整个插件炸掉。
 *
 * @param {string} [file]
 * @returns {Record<string, boolean | number | string>}
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
        // API Key 只认语义侧车：就算有人手工把它写进 recall.json 也直接忽略，
        // 避免 key 在两个文件里分叉（页面改一侧、运行时读另一侧）。
        if (spec.ragOnly === true) continue;
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
 * @param {Record<string, boolean | number | string>} overrides
 * @param {string} [file]
 */
export function writeRecallOverrides(overrides, file = recallOverridesPath()) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    writeFileSync(tmp, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
}

/**
 * 把覆盖层合并进运行时 config（原地修改，监听器持有同一个对象引用）。
 *
 * @param {Record<string, any>} config
 * @param {Record<string, boolean | number | string>} overrides
 * @returns {Record<string, any>}
 */
export function applyRecallOverrides(config, overrides) {
    for (const [key, value] of Object.entries(overrides ?? {})) {
        const spec = SPEC_BY_KEY.get(key);
        if (spec === undefined) continue;
        if (spec.ragOnly === true) continue;
        config[key] = value;
    }
    return config;
}

/**
 * 造设置项。值从运行时 config 现取，`onChange` 由宿主入口提供。
 *
 * API Key 项例外：页面**永远不回显**（value 恒为空串），描述里只显示
 * 「已配置 / 未配置」——既避免把密钥复制到剪贴板/截图，也避免用户把回显的
 * 掩码当成真 key 又提交一次。
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
    const keyConfigured = resolveSemanticApiKey(config) !== '';

    const items = SETTINGS_SPECS.map((spec) => {
        const secret = spec.secret === true;
        let value;
        if (spec.kind === 'toggle') value = config[spec.key] === true;
        else if (secret) value = '';
        else value = String(config[spec.key] ?? '');

        let description = spec.description;
        if (secret) {
            description += keyConfigured
                ? '（当前：已配置，不回显；填新值即替换，留空不改动）'
                : '（当前：未配置，语义召回退回纯 BM25）';
        }

        return {
            id: 'recall.' + spec.key,
            group: spec.group ?? SETTINGS_GROUP,
            title: spec.title,
            description,
            kind: spec.kind,
            order: spec.order,
            value,
            onChange: (next) => onChange(spec.key, next),
        };
    });

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
