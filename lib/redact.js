/**
 * 二次脱敏：注入前对每条命中正文再跑一遍打码。
 *
 * 为什么要在召回侧再打一次码：
 *  - 主插件写 JOURNAL 时已经拦过一次（`validateEntry` 命中敏感串直接 drop），
 *    但 JOURNAL 是**用户可手改、历史可回灌、旧版本可留下**的文件；召回是它进入
 *    提示词的最后一道门，不能假设上游永远干净。
 *  - 召回与 consolidate 是并行开发的两个包，运行时**不能**跨包 import：装到同一
 *    profile 里的包版本可能不一致，一个把主插件目录写死会在打包后被裁掉。
 *    所以这里独立实现一份，规则与主插件 `lib/store.js` 的 `SECRET_RULES`
 *    **逐条对齐**，`test/redact.test.mjs` 做 parity 对拍（能 import 主插件时直接
 *    比对同一批输入的输出）。
 *
 * 规则顺序有意义，别重排：
 *  1. 私钥块最先（整块吃掉，免得被后面的卡号/手机号规则切碎）；
 *  2. `BEGIN … PRIVATE KEY` 半截也打码（截断的私钥同样泄密）；
 *  3. 身份证在银行卡之前（18 位身份证也会命中 16–19 位卡号规则）。
 *
 * 与主插件一致的口径：打码占位符统一 `⟨redacted⟩`，返回 `{ text, hits }`，
 * `hits` 是命中的规则名（用于诊断，不进提示词）。
 */

/** 打码占位符：与主插件 `lib/store.js` 同一串，别改。 */
export const REDACTED = '⟨redacted⟩';

/**
 * 敏感串正则表（与主插件 `lib/store.js` 的 `SECRET_RULES` 逐条对齐）。
 * @type {{ name: string, pattern: RegExp, replace: (match: string) => string }[]}
 */
export const SECRET_RULES = [
    {
        name: 'private-key',
        pattern: /-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*?-----END[^\n]*PRIVATE KEY-----/g,
        replace: () => REDACTED,
    },
    { name: 'private-key', pattern: /-----BEGIN[^\n]*PRIVATE KEY-----/g, replace: () => REDACTED },
    { name: 'openai-key', pattern: /sk-[A-Za-z0-9_-]{16,}/g, replace: () => REDACTED },
    {
        name: 'credential',
        pattern: /(api[_-]?key|token|password|passwd|secret)\s*[:=]\s*\S{6,}/gi,
        replace: (match) => {
            const separator = match.search(/[:=]/);
            return separator < 0 ? REDACTED : `${match.slice(0, separator)}=${REDACTED}`;
        },
    },
    { name: 'bearer', pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/g, replace: () => `Bearer ${REDACTED}` },
    { name: 'mobile', pattern: /\b1[3-9]\d{9}\b/g, replace: () => REDACTED },
    { name: 'id-card', pattern: /\b\d{17}[\dXx]\b/g, replace: () => REDACTED },
    { name: 'bank-card', pattern: /\b\d{16,19}\b/g, replace: () => REDACTED },
];

/**
 * 打码：返回 `{ text, hits }`。
 *
 * 不抛错：正则都带 `g`，这里每条规则前都重置 `lastIndex`，被外部复用同一个
 * 正则对象也不会出现「第一次命中、第二次漏掉」的状态泄漏。
 *
 * @param {unknown} text
 * @returns {{ text: string, hits: string[] }}
 */
export function redactSecrets(text) {
    if (typeof text !== 'string' || text === '') return { text: typeof text === 'string' ? text : '', hits: [] };
    let out = text;
    const hits = [];
    for (const rule of SECRET_RULES) {
        rule.pattern.lastIndex = 0;
        if (!rule.pattern.test(out)) continue;
        rule.pattern.lastIndex = 0;
        out = out.replace(rule.pattern, rule.replace);
        hits.push(rule.name);
    }
    return { text: out, hits };
}
