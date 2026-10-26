# 替代 mnemon：差距清单

> 目标不是共存，是**有一天能关掉 dsh-mnemon**。这份文件记录：它有什么、我们有什么、还差什么、关掉的判定标准。

---

## 一、mnemon 提供的东西（从它的 package.json / 配置 schema / 工具表读出来的）

| 能力 | 证据 |
| --- | --- |
| 自动注入运行时记忆 | 每轮上下文顶部的 `MNEMON RUNTIME MEMORY SNAPSHOT`（USER.md + MEMORY.md 投影） |
| 项目文档 | `mnemon_document_create / search / manage`（含归档与冷引用） |
| 多记忆空间 + 第三方 provider | `memoryTopology.layers`、`persistenceStrategy.providers`（OpenViking/Honcho/Mem0/…） |
| 图谱 | `mnemon_link`（temporal/semantic/causal/entity）、`mnemon_related` |
| 语义召回（可选） | `embedding` 配置，默认关闭，指向本地 ollama |
| 技能自进化 | `skills.evolution / autoBacktest / reviewThreshold / expiryDays…` |
| 侧边栏面板 | `dsh.client` + `sidebar.panellist` |
| 设置页 | `Config` schema（storageScope / runtimeMemory / timeoutMs / defaultRecallLimit…） |
| 子代理结果回写 | `mnemon_subagent_result` |
| 视图路由 | `mnemon_view_route / mnemon_view_action` |

---

## 二、LOOM 现状对照

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 自动注入 | ✅ 今天补上 | `systemPrompt.section` 每轮注入热记忆（规则全进、事实只进最近 8 条），受 `hotBytes` 约束 |
| 使用协议 | ✅ | 第二段 section 告诉模型何时写、何时查 |
| 显式工具 | ✅ 9 个 | 写/读/目录/热记忆/结算/遗忘扫描/校验/遗忘/统计 |
| 事实账本 + 可验 | ✅ | L0 哈希链 + `memory_verify` |
| 可删除 | ✅ | 单条墓碑 + epoch 加密销毁（`loom shred`） |
| 遗忘策略 | ✅ | kind 差异化半衰期 + 用进废退 |
| 作用域 | ✅ 今天补上 | `scope: global | workspace` |
| 导出/导入 | ✅ | 可读 JSON、按内容指纹幂等 |
| 渲染策略 | ✅ | legend / plain / xml |
| 项目文档 | ✅ 今天补上 | memory_doc_write / memory_doc_search，独立 doc 表 + FTS，长文不受 AI文 限制 |
| 多空间 / provider | ❌ | 只有一个账本 |
| 图谱（link/related） | ✅ | `edge` 表 + `memory_link` / `memory_related`，支持四类边与 BFS |
| 语义召回 | ❌ | 纯词面 |
| 技能自进化 | ❌ | 不做，也不打算做 |
| 侧边栏面板 | ❌ | 宿主侧只有 Host，没有 Client |
| 设置页 | ❌ | 没有 `Config`（见下） |
| 自动写入 | 🟡 部分 | `memory_note` 原样捕获（不拒绝，长文进文档）+ 协议提示；真正的「不靠模型自觉」还没做 |

---

## 三、两个硬约束（决定工期）

### 1. 插件是 `link:` 安装，Client 侧需要构建

现在 `loom-memory` 在 profile 里是软链。**Host 侧代码改了不用打包**，但 Client 侧（侧边栏/设置页）必须产出打包好的 `lib/client.js`——mnemon 那个文件有 962 KB。

也就是说：**侧边栏和设置页不是"写个组件"，而是"引入构建链"**。

### 2. 不能在会话里重启宿主

插件模块加载后不会热更。所以每次改插件，验证都得等一次重启。
这决定了节奏：**先写完一批，再一次重启验**，而不是改一点验一点。

---

## 四、差距与优先级

### P0 —— 关掉 mnemon 之前必须有

1. **项目文档**（mnemon 的 `document_*`）
   把"这个项目的知识"和"关于用户的事实"分开。LOOM 现在只有一个事实账本，长文档会被 AI文 的短断言规则拒绝（B1 长度上限）。
   做法：新表 `doc` + `doc_chunk`，复用同一个 L0 与 epoch，检索仍走 bigram（可后加 embedding）。

2. **自动写入**
   现在依赖模型听话调工具。mnemon 是自动抽取。
   做法：在 `agent/pre-step` 里做一轮**廉价判定**（用户说了"记住/以后/我们约定"），命中才让模型走 `memory_write`；不命中就不打扰。

### P1 —— 体验对齐

3. **设置页**（需要打包链）
   先有 `Config` schema（schemastery 在 profile 里存在，但软链插件解析不到，需要 vendor 或改安装方式），再做 Settings section。

4. **侧边栏面板**
   列表 + 搜索 + 校验按钮。同样需要打包链。

### P2 —— 锦上添花

6. 语义召回：bigram 对同义改写无能为力。

---

## 五、什么时候可以关掉 mnemon

按这个顺序打勾，全绿就可以关：

- [ ] 每轮注入的热记忆里，能看见我最近记的东西
- [ ] 说"记住 X"，下一轮就能在注入里看到 X
- [ ] 问"上次那个方案"，能取回且标注来源
- [ ] 项目文档能写能查（不是只有短断言）
- [ ] 我说"忘掉 X"，之后不再被召回
- [ ] 侧边栏能看到、能搜、能点校验
- [ ] 关掉 mnemon 一周，没有"它以前会自动帮我想起来"的缺失感

前六条是功能，**第七条是真正的判据**。

---

## 六、当前进度（2026-10-26）

```
✅ 热记忆自动注入（今天）
✅ 使用协议 section（今天）
✅ 工作区作用域（今天）
✅ 项目文档（今天）
✅ 14 个工具 / L0 哈希链 / epoch 销毁 / 导出导入 / 遗忘策略
🟡 P0-2 自动写入：捕获与兜底已做，钩子未接
🟡 P1-3 设置页：Config 已导出，渲染待重启确认
⬜ P1-4 侧边栏（需打包链）
```

测试：133 个，含 18 轮会话自测、注入断言、文档检索与捕获兜底。
