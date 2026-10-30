# @dsh-external/dsh-persona-memory-recall

`@dsh-external/dsh-persona-memory` 的**附属插件**：给只写不召回（search）的
`JOURNAL.jsonl` 补上自动召回 —— **每轮用户消息到达时**，把它当查询做一次 BM25 检索，
把命中的历史片段作为一条 `user/message` 追加到本轮用户消息之后。

| | |
|---|---|
| 许可证 | MIT，见 [LICENSE](./LICENSE) |
| 安装规格 | `github:hu568/dsh-plugin-persona-memory-recall` |
| 依赖 | 父插件 `@dsh-external/dsh-persona-memory`（只读它的 `JOURNAL.jsonl`，**不 import 它的代码**） |
| 运行依赖 | `schemastery`（别名安装 `npm:@deepseek-ai/schemastery@3.18.2`） |
| 平面 | **宿主组合**（对所有 agent 预设的每个会话生效） |
| 设置页 | 「设置 → 记忆 → 自动召回」（需父插件提供 `ctx.personaMemory`） |
| 确定性 | 同样的查询 + 同样的日志 → 同样的输出（无随机、无 LLM 调用） |

## 它补的是哪个缺口

父插件把长期日志设计成「不注入、按需 search」：省 token、KV 缓存稳定，但
**模型得自己想起来去查**。README 里也承认这是「提示不是保证」。

本插件把「想起来」变成机制：每轮自动召回一次，召回内容只占一个小预算。

父插件保持 0.5.0 原样，一行不改；本插件可以单独安装/停用。

## 注入位置：追加一条 user 快照，不改系统提示词

```
系统提示词（父插件的 memory:soul / memory:user / memory:facts，首条消息冻结）
历史消息
本轮用户消息
<recalled-journal source="JOURNAL.jsonl" hits="2">
- 2026-10-30 [dsh,command-code] 薄壳模式：在宿主层短路 llm/stream，每轮只调用一次 cmd…
- 2026-10-11 [persona-memory] FACT.md 改成 100 行 AND 8000 字节双闸口，超限直接拒写…
</recalled-journal>

以上是按本轮消息从长期日志（JOURNAL.jsonl）自动检索到的历史笔记，已与 FACT.md / 项目 MEMORY.md 去重。
它们可能过时，或只是同词不同义；当作线索而非事实。需要更多/更旧的笔记仍用 memory action=search。
        ↑ 这一条是插件追加的 user/message（source.kind = persona-memory-recall）
```

### 为什么不是系统提示词段落

系统提示词在最前面：每轮改一次，就从那一点开始**击穿整条 KV 缓存前缀**（系统段 + 全部历史）。
父插件整套「首条消息冻结快照」的取舍就是为了这个，不能从这里拆掉。

宿主自己的 `@deepseek-ai/dsh-time-context` 用的就是这个合同：

- 「Each injection is one additional user-role message in the durable history」
- 「KV Cache effect: Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.」

本插件的实现走同一条路：`agent/pre-step` 瀑布里 `await next()` 之后往
`decision.messages` 末尾追加一条消息，消息形状与宿主 `createUserMessage` 一致
（`role: 'user'`），并以 `source = { kind: 'persona-memory-recall', form: 'snapshot', sections: [...] }`
标记来源。`form: 'snapshot'` 让客户端按「上下文快照」渲染，不会显示成用户原话。

### 代价与四条护栏

宿主自己的文档也写明：注入的消息**会累积到下一次 compaction 才被遮掉**。
所以这里不能「每轮都塞满」，护栏是：

1. **同一轮同一查询只注入一次** —— 工具循环 step 2..N 不重复（按 query 哈希去重）；
2. **没有命中就不发** —— 分数不够、与 `FACT.md`/项目 `MEMORY.md` 重复，一条都不发；
3. **字符预算** —— 默认 600 字符（≈190 tok），按排名从高到低装填；
4. **子代理默认不注入** —— 与父插件「子代理只拿项目记忆」的收窄保持一致。

## 召回管线

```
JOURNAL.jsonl（只读尾部 scanEntries 条，默认 500）
  → 解析 {ts,tags,text}，坏行跳过
  → 切段：按「。！？；;!?换行」切，合并到 chunkChars（默认 300），每条最多 12 段
  → 分词：NFKC + 小写；拉丁/数字整词；CJK 取 2-gram（含停用词/助词过滤）
  → BM25（k1=1.2, b=0.75）；tags 词以双倍词频计入
  → 时间衰减：score × (1 + 0.15 × e^(−ageDays/30))（可关）
  → 绝对分门槛 minScore + 相对门槛 top×relativeCut
  → 去重（同文片段 + 与 FACT.md/项目 MEMORY.md 的重复）
  → 按 maxChars 预算装填 topK
  → 渲染
```

**为什么按段而不是按条**：本机真实日志 139 条约 361 KB，平均单条 2.6 KB。
按整条打分会被同一条里的无关段落稀释，按段才能定位到具体那一行。

**为什么中文用 2-gram**：日志里全是自造词（「薄壳模式」「双闸口」「千星」），
词典分词会切错；2-gram 不需要词表，而且 BM25 只需要倒排。

**索引缓存**：按 `mtimeMs:size` 缓存。文件没变时只做打分（毫秒级）；真实日志
139 条建索引约 33 ms（本机实测），之后缓存命中 0 ms。

实测样例（2026-10-30，本机真实日志）：

```
索引：139 条 / 837 段 / 361255 字节，构建 33 ms
查询：薄壳 上限 面板 记忆 插件
结果：ok，命中 2 段，436 字符
  [12.35] 2026-10-11 [dsh,persona-memory,…] 按主人要求做三件事：①清洗 FACT.md…
  [10.56] 2026-10-30 [dsh,command-code,…] 薄壳仍需要合法 DSH 模型路由只为 prepareCall…
```

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 总开关 |
| `journalPath` | `''` | 空 = `$DSH_HOME/memory/JOURNAL.jsonl` |
| `topK` | `5` | 最多注入几段 |
| `maxChars` | `600` | 本轮命中行的总字符预算 |
| `perChunkChars` | `240` | 单段渲染截断长度 |
| `chunkChars` | `300` | 建索引时单段目标长度 |
| `maxChunksPerEntry` | `12` | 每条日志最多切几段 |
| `scanEntries` | `500` | 只索引日志尾部 N 条 |
| `minScore` | `1.0` | BM25 绝对分门槛 |
| `relativeCut` | `0.35` | 低于「最高分 × 该比例」的命中丢掉 |
| `recencyHalfLifeDays` | `30` | 时间衰减半衰期；`0` = 关闭 |
| `recencyWeight` | `0.15` | 时间衰减最大加成比例 |
| `minQueryTokens` | `2` | 查询 token 少于此数不召回 |
| `minTurnsBetween` | `0` | 两次注入之间至少间隔几轮 |
| `subagent` | `false` | 子代理会话是否也注入 |
| `dedupeAgainstMemory` | `true` | 与 FACT.md / 项目 MEMORY.md 去重 |
| `maxQueryChars` | `1500` | 查询只取用户消息末尾这么多字符 |
| `debug` | `false` | 把每次注入/跳过的原因写进宿主日志 |

例：

```yaml
- insert:
    - id: persona-memory-recall
      name: '@dsh-external/dsh-persona-memory-recall'
      config:
        maxChars: 800
        topK: 6
        debug: true
```

## 设置页：记忆 → 自动召回

父插件在 DSH「设置 → 记忆」页留了扩展点。本插件通过
`ctx.personaMemory.settings.register()` 注册声明式设置项，页面只负责渲染与
回写，不用本插件自带界面。按用途拆成两组：

- **自动召回**（主开关 + 只读日志路径）：始终展开，一眼能看到当前是否开启；
- **自动召回 · 高级**（参数项）：超过 3 项，页面按分组折叠规则默认收起，
  点分组标题展开，避免把「记忆」页撑长。

| 项 | 分组 | 控件 | 默认 | 说明 |
|---|---|---|---|---|
| `recall.enabled` | 自动召回 | 开关 | 开 | 每轮自动召回总开关 |
| `recall.journal` | 自动召回 | 只读 | — | 当前生效的日志文件路径 |
| `recall.maxChars` | 高级 | 文本 | `600` | 每轮字符预算（≥80） |
| `recall.topK` | 高级 | 文本 | `5` | 最多命中段数（≥1） |
| `recall.minScore` | 高级 | 文本 | `1` | BM25 绝对分门槛（≥0） |
| `recall.scanEntries` | 高级 | 文本 | `500` | 索引日志尾部条数（≥1） |
| `recall.minTurnsBetween` | 高级 | 文本 | `0` | 两次注入最小间隔（≥0） |
| `recall.subagent` | 高级 | 开关 | 关 | 子代理会话是否也召回 |
| `recall.dedupeAgainstMemory` | 高级 | 开关 | 开 | 与 FACT.md / 项目 MEMORY.md 去重 |
| `recall.debug` | 高级 | 开关 | 关 | 诊断日志 |

回写只存**用户显式改过**的键，落在 `$DSH_HOME/memory/recall.json`（与父插件的
`injection.json` 并列）；没设过的键仍取 `cordis.patch.yml` 里的 config，删掉文件
即恢复组合默认值。开关与数值**下一轮就生效**（监听器每轮现读 config；改
`scanEntries` 会丢掉索引缓存并按新条数重建）。

非法值（非数字、越界、非整数）会直接抛错：页面保留旧值并显示原因，不会出现
「页面显示一个数、实际生效另一个数」。`ctx.get('personaMemory')` 拿不到服务时
（父插件未装或尚未就绪），注册走 `ctx.inject(['personaMemory'], …)` 等待补注册；
两者都没有时静默跳过 —— 召回本身照常工作，只是没有页面开关。

## 日志格式契约

本插件只读 `JOURNAL.jsonl`，格式与父插件 `memory action=append` 完全一致：

```json
{"ts":"2026-10-30T01:30:21.036Z","tags":["dsh","command-code"],"text":"…"}
```

- 一行一条 JSON；坏行跳过，不影响其它条目；
- `text` 为空的条目忽略；
- `tags` 用于加权与展示（不是过滤条件）；
- 日志**没有上限**是父插件的有意设计；本插件只索引尾部 `scanEntries` 条，
  更旧的笔记仍然可以 `memory action=search`。

## 安装

```powershell
# DSH 内置插件管理器（创造模式）：
#   plugin_manager  action=install_bundle  target="github:hu568/dsh-plugin-persona-memory-recall"

# 或命令行：
dsh plugin --profile <profile> add github:hu568/dsh-plugin-persona-memory-recall
```

安装后本包被追加进 profile 的 `dsh.profile.bundles`，其 `cordis.patch.yml` 把
`persona-memory-recall` 一行插进宿主组合。

**注意**：本插件是宿主半 JavaScript，改完 `lib/*.js` 必须重启 DSH 才生效
（原因与父插件 README「排错：改完 lib/*.js 为什么还是旧行为」相同：DSH 默认不监听
`node_modules`，ESM 有加载缓存）。

卸载：

```powershell
dsh plugin --profile <profile> remove @dsh-external/dsh-persona-memory-recall
```

卸载不会删除日志，也不会影响父插件。

## 回归测试

```powershell
# 统一入口（自动跑仓库源码 + profile 里已安装的那份）
pwsh -File test/run-all.ps1

# 也可以单独跑纯 node 的用例
node test/tokenize.test.mjs
node test/chunk.test.mjs
node test/bm25.test.mjs
node test/journal-cache.test.mjs
node test/select.test.mjs
node test/query.test.mjs
node test/inject.test.mjs
node test/settings.test.mjs
node test/real-data.test.mjs        # 只读真实日志
```

需要宿主包的 `cordis-integration.test.mjs` 必须用 Harness 的 Electron node 跑
（`run-all.ps1` 会自动处理）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' test/cordis-integration.test.mjs
```

| 测试 | 验什么 |
|---|---|
| `tokenize.test.mjs` | CJK 2-gram、拉丁整词、NFKC、停用词/助词 |
| `chunk.test.mjs` | 句末合并、超长句硬切、条数上限、换行保留 |
| `bm25.test.mjs` | 排序、IDF、空语料、未知词 |
| `journal-cache.test.mjs` | stat 缓存、增量重建、坏行容错、`scanEntries` |
| `select.test.mjs` | 命中/不命中、预算、去重、`topK`、空日志 |
| `query.test.mjs` | 只认 `source.kind==='user'`、回溯到 `turn/start`、截断、子代理判定 |
| `inject.test.mjs` | 注入形状、同轮去重、换查询再召回、子代理/开关/abort、异常降级 |
| `settings.test.mjs` | 记忆页注册、`ctx.inject` 补注册、回写校验/落盘、覆盖层坏值回落、卸载撤项、索引重配 |
| `cordis-integration.test.mjs` | 真实 cordis 挂载 + 真实 `agent/pre-step` 派发 + dispose 摘监听 |
| `real-data.test.mjs` | 真实 `$DSH_HOME` 日志只读冒烟（构建耗时、缓存、渲染） |

## 已知边界

- **注入会累积到下一次 compaction**：这是宿主 `agent/pre-step` 注入的固有代价，
  `time-context` 也一样。护栏只能减少次数与体积，不能消除。
- **不做语义检索/向量**：只有 BM25，同义改写（「召回」vs「检索」）不一定命中。
  要语义层就得引入 embedding，那是另一个量级的依赖。
- **只看日志尾部**：默认 500 条；更旧的笔记要 `memory action=search`。
- **查询就是本轮用户消息**：不做 LLM query rewrite（不想为了召回再花一次模型调用）。
- **中文按 2-gram**：召回率优先，偶尔会有噪声命中；`relativeCut` 与 `maxChars` 兜底。
- **子代理默认不注入**：与父插件的收窄策略一致；需要时设 `subagent: true`。
- **不生成记忆**：本插件只读日志。自动沉淀（dream/归纳）是另一个功能，不在本包。

## 仓库结构

| 路径 | 角色 |
|------|------|
| `lib/index.js` | 插件入口：Config、pre-step 监听、查询提取、会话态 |
| `lib/journal.js` | 日志读取、切段、索引缓存 |
| `lib/chunk.js` | 长条目切段 |
| `lib/tokenize.js` | CJK 2-gram + 拉丁整词 |
| `lib/bm25.js` | BM25 打分 |
| `lib/recall.js` | 阈值/去重/预算/渲染（纯函数） |
| `lib/memory.js` | 读 FACT.md 与项目 MEMORY.md（只用于去重） |
| `lib/settings.js` | 记忆页设置项 + `$DSH_HOME/memory/recall.json` 覆盖层 |
| `lib/types/index.d.ts` | 类型声明 |
| `cordis.patch.yml` | 组合包层：把插件行插进宿主组合 |
| `test/*.mjs` | 回归测试 |

`lib/` 下的 JS **就是源码**，纯 ESM，无构建链。

## 协议

MIT License，全文见 [LICENSE](./LICENSE)
