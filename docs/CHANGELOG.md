# 变更记录

本文件保存该插件的历史变更记录。新变更继续追加在此处，README.md 只保留最近一版的摘要。

更早的提交级细节见 git 历史。

---

### 0.5.0：少注入废话（D1–D5 + B3）

| 改动 | 为什么 | 落在哪 |
|---|---|---|
| 插到用户消息之前 | 追加在之后时模型最后读到工程日志，语体被拉走甚至当待办 | `lib/index.js` 主召回路径 splice@lastUserIndex |
| 命中门槛 | 单个常见 2-gram 巧合命中（「天气插件」→「插件」）曾注入 4 条 1.76 分无关日志 | `lib/bm25.js` 回传 matched/docLen；`recall.js` hitGate |
| topK 分档 5/4/3/1 | 弱命中只值 1 个名额，强命中才值得多占预算 | `recall.js` effectiveTopK（阈值 = minScore × 3 / 2 / 1.5） |
| 跨轮去重 | 换措辞命中同一段会重复注入，累积到下一次压缩 | 会话状态 injected 指纹集合；`compaction/end` 清空 |
| 前言瘦身 | 旧壳 240/600，topK=5 实际只装 1–2 条 | 前言 + 标签壳 240 → 167 字符 |
| 预算不足可见 | 预算 80 时静默零注入，页面却显示「已开启」 | 启动日志 + 每会话一次 warn；`budgetViability()` |
| 开窗截断 | 从片头切会把命中句切掉 | `clipAroundHit()` 从首个命中词 ±60 |
| 行级 Dice 去重 | 「整段 chunk 被子串包含」对单行结论几乎永不命中 | `lib/dedupe.js`（阈值 0.7 可配） |
| 工作区隔离 | 「看书学习」命中工程日志 3.14 分 | `lib/workspace.js`；JOURNAL 行 cwd / workspaceId |


