/**
 * 二次脱敏回归：规则逐条命中 + 与主插件 `redactSecrets` 的 parity 对拍。
 *
 * parity 的意义：召回侧为了不跨包 import 复刻了一份规则表（见 lib/redact.js 头注释）。
 * 两份实现一旦分叉，就会出现「主插件认为要拦的串，召回侧照原样注入」——这里用同一批
 * 输入对拍输出，分叉立刻失败。主插件不在旁边（单独装本包）时跳过对拍，但 fixture
 * 断言永远会跑，所以测试本身仍能失败。
 *
 * 跑法：node test/redact.test.mjs
 */

import assert from 'node:assert/strict';
import { REDACTED, redactSecrets, SECRET_RULES } from '../lib/redact.js';

/* ══ 1. 逐条规则：该打的都打 ══ */
{
    const cases = [
        ['手机号', '联系 13912345678 处理', '联系 ⟨redacted⟩ 处理', 'mobile'],
        ['身份证', '证件 110101199003071234 已核', '证件 ⟨redacted⟩ 已核', 'id-card'],
        ['银行卡', '卡号 6222021234567890 到期', '卡号 ⟨redacted⟩ 到期', 'bank-card'],
        ['sk- key', '配置 sk-abcdefghijklmnopqrst 就好了', '配置 ⟨redacted⟩ 就好了', 'openai-key'],
        ['Bearer', 'Header 里写 Bearer abcdefghijklmnopqrstuvwxyz', 'Header 里写 Bearer ⟨redacted⟩', 'bearer'],
        ['token=', 'token=supersecretvalue 别外传', 'token=⟨redacted⟩ 别外传', 'credential'],
        ['api key', 'api_key: 1234567890abcdef 记录', 'api_key=⟨redacted⟩ 记录', 'credential'],
    ];
    for (const [name, input, output, rule] of cases) {
        const result = redactSecrets(input);
        assert.equal(result.text, output, `${name} 打码结果不对`);
        assert.ok(result.hits.includes(rule), `${name} 应记录规则名 ${rule}，实际 ${result.hits.join(',')}`);
    }
}

/* ══ 2. 私钥块整块吃掉（不能只打掉头尾） ══ */
{
    const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const result = redactSecrets(`前 ${block} 后`);
    assert.equal(result.text, `前 ${REDACTED} 后`, '私钥块应整块打码');
    assert.ok(!result.text.includes('MIIEowIBAAKCAQEA'), '私钥正文不能残留');

    const half = redactSecrets('半截 -----BEGIN OPENSSH PRIVATE KEY----- 之后');
    assert.ok(half.text.includes(REDACTED), '只有开头的私钥也要打码');
    assert.ok(!half.text.includes('BEGIN OPENSSH'), '私钥头不应残留');
}

/* ══ 3. 干净文本原样返回；空值不炸 ══ */
{
    assert.deepEqual(redactSecrets('薄壳模式：短路 llm/stream。'), { text: '薄壳模式：短路 llm/stream。', hits: [] });
    assert.deepEqual(redactSecrets(''), { text: '', hits: [] });
    assert.deepEqual(redactSecrets(null), { text: '', hits: [] });
    assert.deepEqual(redactSecrets(undefined), { text: '', hits: [] });
}

/* ══ 4. 规则表顺序：先私钥、后卡号（顺序影响打码结果） ══ */
{
    assert.equal(SECRET_RULES[0].name, 'private-key', '私钥规则必须最先跑');
    const names = SECRET_RULES.map((rule) => rule.name);
    assert.ok(names.indexOf('id-card') < names.indexOf('bank-card'), '身份证必须排在银行卡之前');
}

/* ══ 5. 同一条正则反复用不出状态泄漏（g 标志的 lastIndex 必须重置） ══ */
{
    const once = redactSecrets('手机 13912345678');
    const twice = redactSecrets('手机 13912345678');
    assert.deepEqual(once.hits, twice.hits, '重复调用命中集合应一致');
    assert.equal(once.text, twice.text, '重复调用输出应一致');
}

/* ══ 6. parity：与主插件 redactSecrets 对拍（主插件不在旁边就跳过） ══ */
{
    const samples = [
        '联系 13912345678 处理',
        '证件 110101199003071234 已核',
        '卡号 6222021234567890 到期',
        '配置 sk-abcdefghijklmnopqrst 就好了',
        'Header 里写 Bearer abcdefghijklmnopqrstuvwxyz',
        'token=supersecretvalue 别外传',
        'api_key: 1234567890abcdef 记录',
        'password=iloveyou123',
        '半截 -----BEGIN OPENSSH PRIVATE KEY----- 之后',
        '前 -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY----- 后',
        '干净文本，没有秘密。',
    ];

    let main = null;
    try {
        main = await import('../../dsh-plugin-persona-memory/lib/store.js');
    } catch (error) {
        console.log(`（parity 对拍跳过：主插件不可达 — ${String(error?.message ?? error)}）`);
    }
    if (main !== null && typeof main.redactSecrets === 'function') {
        for (const sample of samples) {
            const mine = redactSecrets(sample);
            const theirs = main.redactSecrets(sample);
            assert.equal(mine.text, theirs.text, `与主插件打码结果分叉：${sample}`);
            assert.deepEqual([...new Set(mine.hits)].sort(), [...new Set(theirs.hits)].sort(), `规则名分叉：${sample}`);
        }
        console.log('parity 对拍：与主插件 redactSecrets 一致');
    }
}

console.log('✓ redact.test.mjs 全部通过');
