# LOOM

> 分层记忆：**AI文 做证据、题档 做路标、哈希链保证可验、epoch 加密保证可删。**

零依赖（只用 Node 22 内置的 `node:sqlite` / `node:crypto` / `node:test`），没有构建步骤。

## 跑

```bash
npm test          # 31 个测试（node --test 原生发现）
npm run verify    # 9 条工程门禁断言
npm run demo      # 端到端：写入 → 检索 → 取回 → 冲突 → 删除
npm run check     # test + verify
```

`verify` 是真的门禁：任何一条不过就退出码 1。

```
PASS  AI文 全过闸门  30/30
PASS  正文不含尾部元数据
PASS  碎片全被拒  0 通过
PASS  检索「鉴权」有结果
PASS  检索「1Password」有结果
PASS  取回不超预算  200/200
PASS  哈希链可验  {"ok":true,"count":30}
PASS  销毁后内容不可读
PASS  销毁后链仍可验
verify: 9/9 通过
```

## 结构

```
packages/loom-core/
├── src/
│   ├── contracts.js      窄腰：Claim / GateResult / TokenCounter
│   ├── aiw.js            AI文：三档、剥尾、别名、规则版 must_keep
│   ├── constrain.js      ★ must_keep 前移：先定事实，再让生成器照着写
│   ├── gate.js           四道判定：格式 / 元数据 / 保真 / 编造
│   ├── ingest.js         ★ 写入收口（唯一能造 claim 的函数）
│   ├── ledger.js         内存版（测试用）
│   ├── sqlite-ledger.js  L1：SQLite + FTS5 bigram + external_ref
│   ├── chronicle.js      L0：append-only + 哈希链 + epoch 加密
│   ├── staleness.js      ★ 外部引用时效：文件 hash / URL ETag
│   └── allocate.js       预算取回：正文 → 标题 → 指针
├── test/                 31 个测试，5 个文件
└── bin/loom.js           CLI：demo / verify / gate
```

## 写入为什么只有一个入口

`ingest()` 是唯一能造 claim 的函数：

```
作者行（带 @时间 #来源 置信）
  → stripTail      尾部不进正文（实测省 31% token）
  → parseTail      拆成 source / confidence 字段
  → gate           格式 / 元数据 / 保真 / 编造
  → ledger.put     L1；调用方另写 L0
```

如果允许多处 `put`，就一定有人忘掉 `stripTail`，31% 的 token 会悄悄涨回来。
`verify` 的第 2 条断言守着它：**正文里拆不出尾部三元**。

> 注意判据是 `parseTail(aiw) === null`，不是「正文里没有 `@` 或 `#`」——
> `@11-05`、`#oncall` 是正文里合法的记号。这个断言我第一版写错过。

## must_keep 前移（W3）

```
旧：生成 → 闸门审判 → 不通过重跑
新：brief() 先定事实 → 约束生成 → checkDraft 立刻校验
```

`brief(original, {modelTerms})` 产出的 `mustKeep` 是**规则地板 ∪ 模型语义项**，
规则那条永远保留——它不可能被生成端影响。

## 外部引用时效（W3）

```js
const ref = fileRef('config/preview.yml');     // 建引用时存 hash
const [checked] = await checkRefs([ref]);      // 之后按需核对
// → fresh | stale | unknown
```

**读不到判 `unknown`，不判 `stale`**——读不到不等于变了。过时的记忆在注入时降权一半并打标。

## 已定死的设计

| 决定 | 原因 |
| --- | --- |
| `aiw` 不含尾部 | 实测剥离省 31% token、准确率掉 1pp |
| 没有 `fragments` 字段 | 只有一种编码；`title` 是题档 AI文 |
| 冲突不删只失效 | `valid_to` + `superseded_by` + 理由留档 |
| 删除权 = 删密钥 | epoch 每段一把；删钥匙内容不可读，墓碑留链上 |
| 检索先转 bigram | `trigram` 对 2 字词命中 0；`unicode61` 把整句当一个词 |
| 拉丁串整段入索引 | `在1Password` 会被切成二元，搜不到 |

## Distill 实测（W3 收口）

```bash
$env:DEEPSEEK_API_KEY=...; npm run distill
```

30 条原文 × 两种约束口径，判分用人工 must_keep：

| 口径 | 通过 | 一次通过 | 平均尝试 | 平均字符 | 人工字符 | 压缩比 |
| --- | ---: | ---: | ---: | ---: | ---: | ---:|
| rule（只用规则抽的事实） | 100% | 93% | 1.1 | 42 | 40 | 1.06× |
| human（给人工资讯） | 100% | 100% | 1.0 | 41 | 40 | 1.02× |

**约束生成把闸门通过率做到了 100%，长度和人工写的持平。** 详见 `distill-report.md`。

## 三问召回（W4）

```bash
npm run recall -- "上次 JWT 那个方案为什么回滚？"
npm run admission          # 第一问的收益核算
```

```
问题：上次 JWT 那个方案为什么回滚？
① 要不要查：查（memory-cue）
② 查哪类：kinds=fact entities=JWT
③ 取多少：目录 1 个节点 / 2 token
   取回 1 条正文 + 0 条指针 · 用掉 9/200
   [full] f78f39b5 改登录鉴权→JWT，refresh轮换→登录失败，故回滚session。
```

**第一问的实测**（`npm run admission`）：

| 输入 | 数量 | 触发检索 |
| --- | ---: | ---: |
| 真实问题（disc/base） | 125 | **100%** |
| abstain 问题 | 75 | 100% |
| 应答 / 寒暄 | 27 | **0%** |
| 纯命令 | 10 | 0% |

**125 个真实问题误杀 0 条，37/37 条非问题被跳过。** 第一问的门槛很低（规则 + 正则），但它省的是整轮检索。

## Settle：用完记忆之后结账（W6，提前做）

```bash
npm run settle            # 归因实测：引用 vs 词面
```

| 指标 | 结果 |
| --- | ---: |
| 引用率（`[#id]` 协议） | **100%** |
| 词面命中率 | 92% |
| 两者一致 | 92% |

12 题，每题只注入一条证据。结论：**引用协议可以当主归因**，词面重合当兜底。

权重规则：

```
用了且对  → salience × 1.15（上限 3）
用了但错  → salience × 0.85（下限 0.05）
没被用到  → salience × 0.98（缓慢衰减）
```

门禁里也有一条：`Settle：被引用则涨权 1.00→1.15`。

## DSH 插件壳（W7）

`packages/loom-dsh/` 是一个 Host-only bundle，注册八个工具：

| 工具 | 作用 |
| --- | --- |
| `memory_write` | 写入一条 AI文（尾部可省；来源默认记「会话」） |
| `memory_recall` | 按问题取回证据，附带可直接注入的 `rendered` 文本 |
| `memory_outline` | 先看目录：按类型分组 + 标题，适合"不确定记过什么" |
| `memory_hot` | 看这一轮自动注入了什么（调 `hotBytes` 时用） |
| `memory_settle` | 结账：哪些被用到、对不对 → 改权重 |
| `memory_decay` | 遗忘扫描（默认预览，`apply` 才标冷） |
| `memory_verify` | 校验 L0 哈希链：条目数、链是否连续 |
| `memory_forget` | 单条失效（不物理删除，墓碑留档） |
| `memory_stats` | 账本概况 |

写入路径已经接上 **L0 编年层**：每次成功写入都会追加到哈希链，
`memory_verify` 随时可验"记忆没被改写"。

**每轮自动注入**：规则与偏好全进、事实只进最近几条，总量受 `hotBytes` 约束；
另有一段使用协议告诉模型何时该写、该查。注入失败不影响工具（有兜底）。

```bash
node tools/plugin-smoke.mjs    # 给 apply() 一个假 ctx，验证工具契约
```

**已安装并激活**，2026-10-26 在真实会话里跑通：

- `memory_write` → `ok: true`，id `1f138898b53fe948`，kind=rule
- `memory_recall`（"预发端口是多少"）→ 命中 1 条 full，6 token

**第一次写入被拒过（B3 + M1），根因是格式设计太窄**：尾部置信只认 `! ? ~`，
使用者写了「高」→ 尾部没剥掉 → 尾部被当正文（不以「。」结尾 = B3）→ 来源抽不出（M1）。
两个错误同一个根因。

已修：`parseTail` / `stripTail` 现在同时接受 `! ? ~` 与 `高 中 低`。
重启后实测：同一句话一次过，**写入成本 ¥0.0635 → ¥0.0071（9× 便宜）**——省下的是那次重试。

### 第二轮真实会话又抓到两个

**① `skipped: short-utterance`**：查「预发端口」（4 个字的名词短语）被 admission 直接跳过。
按长度一刀切会把真实用户最常见的查询形态全部漏掉。已改为**默认查**（只有应答、寒暄、纯命令才跳）。

**② 重复条目**：「；」和「，」的差异被当成两条记忆。
内容哈希原来按原文算，标点不同就不同 id。已改为按**内容指纹**（忽略标点与空白）：
现在两条会指向同一条 claim。

已加的兜底工具：

```bash
npm run dedupe -- --dry     # 先看会合并哪几条
npm run dedupe              # 合并：保留最新，其余 supersede（不删除）
```

在真实库上跑过一次：2 条 → 1 条 active + 1 条 superseded，备份留在 `loom.db.bak-*`。

### 会话自测（不想再靠真实会话踩坑）

`packages/loom-core/test/conversation.test.js` 走**插件真实的工具入口**，模拟 10 轮：

```
0. 三个工具都在
1. 写一条：汉字置信 + 无尾也接受
2. 短名词短语查询：不能被跳过
3. 同一内容、不同标点：合并成一条
4. 完整问句：命中且给出正文
5. 碎片稿：被闸门拒绝且不入库
6. 应答类输入：跳过检索
7. 查不到时：不跳过、也不编
8. 第二条不同内容：独立入库
9. 统计与类型分布对得上
10. 预算约束：取回不超预算
```

写这套自测时又抓到两个，都是**内核测试看不见、只有走工具入口才暴露**的：

**③ 拉丁词被切碎导致误召回**：`bigrams` 把 `Kubernetes` 切成 `Ku/ub/be/er…`，
其中 `er` 撞上了 `docker` → 问 Kubernetes 也会召回 docker 那条。
已改为：纯拉丁/数字整段保留，不再切碎。

**④ 只"类型相同"也算相关**：问一句 Kubernetes，所有 `fact` 条目都能拿到 0.2 分、越过阈值。
已改为：**没有词面或实体信号就直接返回 0**，类型只能加分、不能单独成立。

改完后 `npm test` 是 71 个测试。

> 分词规则变了，索引要重算：`npm run reindex`（会先备份）。

## 你睡觉这段时间补的

| 模块 | 内容 |
| --- | --- |
| `src/decay.js` | 遗忘执行者：kind 差异化半衰期 + 用进废退 + 三档降级 |
| `src/render.js` | 三种渲染策略：legend / plain / xml |
| `src/transfer.js` | 导出/导入：可读 JSON，按内容指纹去重 |
| 插件 | 8 个工具；写入接 L0 哈希链；`memory_verify` / `memory_forget` / `memory_outline` |
| 测试 | 96 → 98，含 5000 条规模测试（单次检索 0.1ms） |

详见 `WAKE-UP.md`（起床报告）。

## 进度

- ✅ W1 骨架 + 契约 + 闸门
- ✅ W2 L0 哈希链 / epoch 加密、L1 SQLite + bigram、写入收口
- ✅ W3 must_keep 前移 + 外部引用时效 + Distill 接线（通过率 100%）
- ✅ W4 三问召回（admission / router / outline）
- ✅ W5 渲染层（三策略）
- ✅ W6 Settle 归因 + Decay scheduler
- 🟡 W7 插件壳：8 个工具、L0 已接；**待重启激活**；自动注入未做

基线在 `../aiw/`：200 题、7 种条件、真 token。任何改动都要能在那里跑出不低于 89% 的 disc 通过率。
