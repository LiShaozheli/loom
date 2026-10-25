# LOOM 实施计划 v1.2

> 目标：把 `aiw/` 里验证过的规则与评测，变成能装进 DSH、每天真在用的记忆插件。
> 前提：1 人，每周约 20 小时，**8 周**。
> 原则：**每周都必须有能跑的验收命令**。没有数字的周，不算完成。

v1.2 相对 v1.1 补了四条（前两条 P0，后两条 P1/P2），并记录了一条明确拒绝。

---

## 0. 边界（不做什么）

| 不做 | 原因 |
| --- | --- |
| 向量库当主索引 | FTS5 + 实体表够用；向量留作可选增强 |
| **参数化记忆（蒸进权重 / MoE 专家）** | **与删除权冲突，见 §8 ADR-001** |
| 混合语言编码 | 真值实测无收益（42 个概念只有 3 个省 1 token） |
| 多用户 / 权限系统 | 单机单人；scope 只分 global / workspace |
| 跨设备同步 | 用导出包代替 |
| 图可视化 | 先存 `edge`，UI 后置 |
| 模型自主决定记什么 | 写时不判；只有 Capture + 异步 Distill |

---

## 1. AI文：这套设计的地基

**一句话**：用 tokenizer 认识的字，把一条记忆写清楚因果与约束——**它不省 token，它省返工**。

**为什么它在地基位置**（全部实测，`deepseek-chat` 真值）：

| 指标 | 碎片摘要 | AI文 |
| --- | ---: | ---: |
| token | 108 | 381 |
| 关键事实保真 | 43.6% | **100%** |
| 下游答对（12 题） | **0%** | **75%** |
| 加符号表后 | — | **92%** |

碎片省下 273 token，代价是 12 道题全部答不出。**所以记忆系统的默认编码必须是 AI文，不是摘要。**

**它在流水线上出现四次**：

```
对话原文
  ↓ ① must_keep 先抽（规则地板 + 独立模型）→ 作为生成约束
  ↓ ② Distill 生成 AI文（提示词见 aiw/GEN.md）
  ↓ ③ Gate 校验（lint + 保真 + 别名 + 编造）
  ↓ ④ 入库：body（白话）+ aiw（AI文）双表示
注入时：aiw 进证据包；body 只在审计、迁移、换模型时出现
```

**四条硬约束**（细则在 `aiw/SPEC.md`）：

1. 一行一断言，尾部 `@时间 #来源 置信`
2. 保真不删清单：否定、数量、时间、条件、情态、标识符
3. 换编码必须登记别名（`auth` 算保住 `鉴权`），别名表固定可审计
4. 符号优先（`→ ! ? @ #`），**语言不换**——真值实测 42 个概念只有 3 个换英文能省 1 token

**它明确的边界**：

- **不省 token**：只比原文省 5.2%，是碎片的 3.5 倍
- **不是文言文**：选词看词表命中，不看古雅
- **单用会读不懂**：靠 ⑤ 渲染层的符号表赎回（+17pp），所以渲染层不是可选装饰

代码位置：`loom-core/src/aiw/{lint,mustkeep,aliases,encode}.ts`，评测在 `loom-eval`。

**三档编码：碎片不是取舍，是被支配**

| 档位 | 用途 | token/条 | 事实保真 | 答对（12 题） |
| --- | --- | ---: | ---: | ---: |
| **题 `title`** | 标题、指针、Outline 节点 | ~8 | 61% | 38% |
| **轻 `lite`** | 分页首批、低预算注入 | ~18 | 91% | 77% |
| **全 `full`** | 证据包正文 | ~22 | 98% | **89%** |
| ~~碎片~~ | ~~索引 / 标题~~ | 7 | 22% | **0%** |

预算曲线（16 条语料、51 个事实，代理分词器）：

| 注入预算 | 碎片 | 题 | 轻 | 全 |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 29% | **45%** | 31% | 24% |
| 200 | 37% | **67%** | 57% | 41% |
| 400 | 37% | 67% | **94%** | 71% |
| 800 | 37%（天花板） | 67% | 94% | **100%** |

**碎片在每一个预算点上都低于至少一个 AI文 档位**——它是被支配（dominated），不是"另一种取舍"。

**结论：架构里不再有"碎片"这个类型，只有同一套 AI文 规则的三个压缩档位。**

三条纪律（写进 W3 验收）：

1. 三档用同一套规则（`aiw/SPEC.md`），只是允许删到什么程度不同；**任何一档都不许删标识符、数字、否定、因果箭头**
2. 每档都必须带 `#来源`
3. 题档 ≤24 字符（汉字 ≤12）；lint 对题档放宽 `@时间`，但 `#来源` 不可省

另外：**`body` 必须从 `aiw` 派生**（单向展开），不得独立生成。否则 `body` 就是一个**没过 Gate 的碎片**——一旦换模型回退用它，碎片就借尸还魂。

---

## 2. 架构改动一览（v1.0 → v1.2）

| # | 改动 | 版本 | 解决什么 |
| --- | --- | --- | --- |
| ⓪ | **AI文 双表示（body + aiw）** | v1.0 | 碎片会丢因果；AI文 保住，且实测答对 92% |
| ① | 检索工具化（`recall` 工具，最多 2 次） | v1.1 | 单轮 RAG：指代、多跳 |
| ② | must_keep 前移成生成约束 | v1.1 | 事后否决太贵 |
| ③ | decay scheduler（三档降级） | v1.1 | 遗忘没有执行者 |
| ④ | epoch 加密 + crypto-shredding | v1.1 | 不可篡改 vs 被遗忘权 |
| ⑤ | 渲染层（legend/plain/xml） | v1.1 | 符号表带来 +17pp 却没地方放 |
| **⑥** | **外部引用 + staleness 检查** | **v1.2** | 记忆指向世界；发现"变旧" |
| **⑦** | **Outline 导航 + 分层预算** | **v1.2** | "展开"不是"披露"，缺可导航的目录 |
| **⑧** | **BM25 权重 + 查询扩展** | **v1.2** | 稀疏检索表征，仍可审计 |
| **⑨** | **异步分页 + 预取** | **v1.2** | 证据组装卡住整轮 |

### ⑥ 外部引用与过时检测

记忆不只要互相联系，还要**指向世界**：文件、URL、仓库 commit、别的会话。没有外部引用，就永远发现不了"这条已经过时了"。

```
新增外部引用（file / url / repo / session）
定时与注入前各查一次：
  file    → sha256 或 mtime
  url     → ETag / Last-Modified
  repo    → commit sha
  session → 是否存在
变化 → claim 标 stale：salience × 0.5，注入时标「!可能过时」，进 Audit 列表
```

### ⑦ Outline：先给目录，再给条目

现在的 `search → expand` 只能"搜到就展开单条"，模型看不见"这个主题下还有什么"。补一层可导航的目录：

```
Outline（≤120 token）：主题 / 实体 / 时间三种节点，带子节点数与 token 估计
  └ expandOutline(nodeId, level='claims'|'bodies')  → 该节点下的条目
      └ expand(claimId) → body + 来源
```

每层扣预算，不许一次拉到底。

### ⑧ 稀疏检索：加权重与扩展，不加参数

FTS5 倒排本身就是稀疏词项矩阵，缺的是两样：

- **BM25 权重**（FTS5 内置 `bm25()`，直接可用）
- **查询扩展**：同义词、实体别名（复用 `alias` 表）、上一轮提到的实体

**只在"可索引"这一侧稀疏，不在"可训练"那一侧稀疏。** 前者是卡片目录，后者是把书烧了变成记忆——后者会让删除权和溯源同时失效。

### ⑨ 异步分页：先给地址，再送书

```
recall.first(query)  → 立即返回 5 条「指针」（≤60 token），不阻塞
  ├─ 后台预取这批的 AI文（下一批同理）
  ├─ recall.more(cursor) → 需要时才取
  └─ 预算耗尽直接停，已预取的丢弃
```

---

## 3. 仓库结构

```
loom/
├── packages/
│   ├── loom-core/
│   │   ├── src/contracts.ts
│   │   ├── src/gate.ts
│   │   ├── src/aiw/{lint,mustkeep,aliases,encode}.ts
│   │   ├── src/recall/{admission,router,tool,page,allocate}.ts
│   │   ├── src/recall/{outline,bm25,expand-query}.ts     # v1.2
│   │   ├── src/external/{refs,staleness}.ts              # v1.2
│   │   ├── src/render/{legend,plain,xml}.ts
│   │   ├── src/decay.ts
│   │   └── src/budget.ts
│   ├── loom-store/
│   │   ├── src/chronicle.ts        # L0 + epoch 加密 + 哈希链
│   │   ├── src/epoch.ts
│   │   ├── src/ledger.ts           # node:sqlite + FTS5(bm25)
│   │   └── src/migrate.ts
│   ├── loom-dsh/
│   └── loom-eval/
└── PLAN.md
```

**分层铁律**：`core` 不 import `store`，`store` 不 import `dsh`。

---

## 4. 契约

```ts
export type ClaimKind = 'fact' | 'pref' | 'rule' | 'proc' | 'relation' | 'open' | 'decision' | 'opinion';
export type Taint = 'none' | 'external' | 'unverified';

export interface ExternalRef {
  kind: 'file' | 'url' | 'repo' | 'session';
  target: string;
  digest?: string;                  // file: sha256 / repo: commit sha / url: etag
  checkedAt?: number;
  status: 'fresh' | 'stale' | 'unknown';
}

export interface ClaimDraft {
  kind: ClaimKind;
  body: string;                     // 白话规范：审计、迁移
  aiw: string;                      // 压缩正文（不含尾部元数据）
  confidence: 'high' | 'medium' | 'low';   // 原 ! ? ~ 改存字段
  scope: Scope;
  source: { eventId: string; start: number; end: number };
  taint: Taint;
  epochId: string;                  // 删除权最小单位
  refs?: ExternalRef[];             // v1.2：指向世界
}

export interface Claim extends ClaimDraft {
  id: ClaimId;
  validFrom: number; validTo?: number;
  supersededBy?: ClaimId;
  salience: number;
  useCount: number; lastUsedAt?: number; cold: boolean;
  stale: boolean;                   // v1.2：由 refs 推导
  createdAt: number; updatedAt: number;
}

// ⑦ 目录
export interface OutlineNode {
  id: string;
  title: string;                    // ≤ 12 字
  kind: 'topic' | 'entity' | 'time';
  children: number;
  claims: number;
  tokens: { self: number; subtree: number };
}
export interface Outline { nodes: OutlineNode[]; totalClaims: number }

// ⑨ 分页
export interface RecallPage {
  items: EvidenceItem[];            // first() 只给指针，more() 才给 AI文
  pointers: { claimId: ClaimId; title: string }[];
  cursor?: string;
  prefetched: number;
}

export interface RecallTool {
  first(input: { query: string; kinds?: ClaimKind[]; since?: number; limit?: number }): Promise<RecallPage>;
  more(cursor: string): Promise<RecallPage>;
  outline(parentId?: string): Promise<Outline>;
  expandOutline(nodeId: string, level: 'claims' | 'bodies'): Promise<RecallPage>;
  expand(claimId: ClaimId): Promise<{ body: string; refs: ExternalRef[]; provenance: Provenance }>;
  readonly callsLeft: number;
  readonly tokensLeft: number;
}

// ⑥ 过时检测
export interface StaleChecker {
  check(refs: ExternalRef[]): Promise<ExternalRef[]>;   // 回填 status / checkedAt / digest
}

// 其余沿用 v1.1：GateResult / TokenCounter / Budget / EvidenceBundle / DecayPolicy / RenderPolicy / EpochStore
```

**五个必须一开始定死的接口**：`{body, aiw}` 双字段、`source` 回源指针、`epochId`、`TokenCounter`、**`refs`（外部引用）**。

---

## 5. 数据表（L1）

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE epoch (id TEXT PRIMARY KEY, key_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL, destroyed_at INTEGER);
CREATE TABLE tombstone (epoch_id TEXT PRIMARY KEY, reason TEXT, ts INTEGER);

CREATE TABLE event (
  id TEXT PRIMARY KEY, epoch_id TEXT NOT NULL, ts INTEGER NOT NULL,
  session_id TEXT NOT NULL, kind TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);

CREATE TABLE claim (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  body TEXT NOT NULL, aiw TEXT NOT NULL,
  bg TEXT NOT NULL DEFAULT '',        -- 中文 bigram，写入时生成（见下）
  scope TEXT NOT NULL, workspace_id TEXT, epoch_id TEXT NOT NULL,
  valid_from INTEGER NOT NULL, valid_to INTEGER, superseded_by TEXT,
  salience REAL NOT NULL DEFAULT 1.0, taint TEXT NOT NULL DEFAULT 'none',
  stale INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, cold INTEGER NOT NULL DEFAULT 0,
  event_id TEXT NOT NULL, src_start INTEGER NOT NULL, src_end INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_claim_kind_scope ON claim(kind, scope, workspace_id);
CREATE INDEX idx_claim_time   ON claim(valid_from, valid_to);
CREATE INDEX idx_claim_decay  ON claim(cold, last_used_at, salience, stale);
CREATE INDEX idx_claim_stale  ON claim(stale);

-- 中文分词的两个坑（都实测过）：
--   unicode61：把「用户彻底怒了」当一个词，搜「彻底」命中 0
--   trigram  ：要求 ≥3 字，MATCH '彻底' 命中 0；「鉴权失败」才命中
-- 所以额外存一列 bigram（unicode61 分词），查询时把 query 也转 bigram：
--   「用户彻底怒了」→「用户 户彻 彻底 底怒 怒了」
CREATE VIRTUAL TABLE claim_fts USING fts5(
  body, aiw, bg, kind,
  content='claim', content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TABLE external_ref (
  claim_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
  digest TEXT, checked_at INTEGER, status TEXT NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (claim_id, kind, target)
);
CREATE INDEX idx_ext_status ON external_ref(status, checked_at);

CREATE TABLE outline_node (
  id TEXT PRIMARY KEY, parent_id TEXT, kind TEXT NOT NULL,
  title TEXT NOT NULL, claims INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE alias (form TEXT PRIMARY KEY, canonical TEXT NOT NULL);
CREATE TABLE entity (id TEXT PRIMARY KEY, name TEXT NOT NULL, canonical TEXT NOT NULL);
CREATE TABLE edge (src TEXT, dst TEXT, rel TEXT, since INTEGER, until INTEGER);
CREATE TABLE settle_log (claim_id TEXT, turn_id TEXT, used INTEGER, correct INTEGER,
                         strategy TEXT, ts INTEGER);
```

---

## 6. 里程碑（8 周）

| 周 | 产物 | 验收命令 | 通过标准 |
| --- | --- | --- | --- |
| **W1** | 骨架 + 契约 + eval 迁入 | `pnpm eval:gate` | 单测绿；碎片 12/12 拒、AI文 12/12 过 |
| **W2** | L0（epoch 加密 + 哈希链）+ L1 + **external_ref** | `pnpm bench:store` / `pnpm rebuild` / `pnpm eval:stale` | 10k 条 p95 < 20ms；kill -9 后 replay 一致；改一个被引用文件 → 对应 claim 24h 内标 stale |
| **W3** | Gate（must_keep **先行**） | `pnpm eval:gate` | 零误杀；REJECT 率 < 5% |
| **W4** | 召回工具化 + **Outline** + **BM25/查询扩展** | `pnpm eval:recall` | 注入中位数 ≤ 400 token；outline 首屏 ≤ 120 token；预算误差 < 5% |
| **W5** | 渲染层（3 策略）+ Distill 双表示 + **分页/预取** | `pnpm eval:qa --render legend,plain,xml` | legend ≥ 90%（复现 92%）；首字节证据延迟 p95 < 50ms |
| **W6** | Decay scheduler + Settle 归因 | `pnpm eval:decay` | 30 天模拟记忆总量收敛；QA 不掉点 |
| **W7** | Audit / Taint / 设置页 / 导出 / 删除 | `pnpm eval:audit` / `pnpm export` | 死记忆与冲突可列；销毁 epoch 后该段不可读且链可验 |
| **W8** | QA 扩到 50 题 + 发布门禁 | `pnpm gate:release` | 50 题 ≥ 90%（三种渲染分别达标） |

**每周五**：验收输出贴进 `WEEKLY.md`。

**超期时的削减顺序**（提前定好，免得临场慌）：`⑧ BM25 扩展` → `⑨ 分页预取` → `⑤ 第三种渲染` → `⑦ Outline 的时间节点`。**`④ epoch` 和 `② must_keep 前移` 不许砍。**

---

## 7. 能力目标

> 估计值，不是测量值。12 题 92% 只能证明机制成立，不能外推。

| 能力 | v1.0 | v1.1 | **v1.2** | 靠哪条 |
| --- | ---: | ---: | ---: | --- |
| 事实跨会话留存 | 90% | 90% | 90% | — |
| 时间推理 | 75% | 80% | 80% | edge 双时态 |
| 冲突与更新 | 80% | 85% | 85% | superseded_by |
| 关系 / 多跳 | 50% | 70% | **75%** | ① + ⑦ |
| 指代与延续 | 40% | 70% | **75%** | ① + ⑧ 查询扩展 |
| 程序性记忆 | 25% | 30% | 30% | 留 v2（skills 自进化） |
| 遗忘与抽象 | 35% | 70% | 70% | ③ |
| 规模（10 万条） | 60% | 75% | **80%** | ⑦ + ⑨ 分页 |
| 时效性 | 0% | 0% | **70%** | ⑥ staleness |
| 多模态 | 0% | 0% | 0% | 不做 |
| 可删除 / 隐私 | 55% | 85% | 85% | ④ |
| 渲染适配 | — | 有 | 有 | ⑤ |

**加权（按真实使用）约 60% → 72% → 78%。**

---

## 8. 两条 ADR（架构决策记录）

### ADR-001：为什么不做参数化记忆

**背景**：有建议把记忆存成稀疏表征的参数（蒸进权重 / MoE 专家），检索时按激活取。

**决定**：不做。

**理由**：

1. **删除权失效**。v1.1 为"被遗忘权"做了 epoch 加密 + crypto-shredding。权重一旦蒸进去，删不掉。
2. **溯源失效**。参数里的知识无法回答"这是哪句话来的"，而 LOOM 的每条 claim 都必须能 `#来源` 回 L0。
3. **迁移失效**。换模型 = 记忆清零，违背"记忆应比模型活得久"。

**保留的部分**：**可索引侧的稀疏**（FTS5 倒排 + BM25 权重 + 查询扩展）。它同样是稀疏表征，但可 `EXPLAIN`、可删除、可迁移。

**代价**：放弃了一部分"模糊联想"能力（参数化记忆擅长这个）。用 ⑦ Outline + ⑧ 查询扩展部分补偿。

### ADR-002：为什么 staleness 用外部引用而不是重新抽取

**背景**：记忆会过时，可以定期重新抽取原文来判断。

**决定**：优先用外部引用比对外部世界（文件 hash / URL ETag / repo sha）。

**理由**：重新抽取是**用假设验证假设**——模型可能给出同样过时的答案；而外部引用比对是**事实核对事实**，成本低两个数量级，且能精确报告"哪一部分变了"。

**限制**：只覆盖"有外部锚点"的记忆；纯对话得出的偏好类记忆无法这样验证，只能靠 Settle 与时间衰减。

---

## 9. 值得抄但还没抄的（排期）

| 出处 | 抄什么 | 落在哪 |
| --- | --- | --- |
| Letta | 记忆即文件系统，agent 自己 grep/read | **W4（已并入①）** |
| OpenViking | 渐进加载（目录 → 概览 → 原文） | **W4（⑦ 已覆盖大半）** |
| mnemon | skills 自进化：经验固化 + 回测后由人采纳 | v2（程序性记忆） |
| mnemon | 契约层：capability 协商 / read grant / receipt | v2（多后端时） |
| Hindsight | beliefs / opinions 网络 | v2（`ClaimKind` 已留 `opinion`） |
| StrataGate | 被采用才算强化（搜索命中不算） | **W6 Settle** |
| dsh-tide-memory | 差异化衰减：事实不衰减、事件按半衰期 | **W6（DecayPolicy 按 kind 分支）** |
| Graphiti | edge 双时态 | **W2 建表即有** |

---

## 10. 风险与触发条件

| 风险 | 触发信号 | 应对 |
| --- | --- | --- |
| staleness 检查把 IO 打爆 | 每轮 check > 50ms | 批量 + 缓存 + 只在注入前与每日定时各一次 |
| 外部引用误报 | 文件被格式化工具重写 → 全量 stale | file 只比内容 hash，不比 mtime；repo 只比被引用路径的 blob sha |
| Outline 膨胀 | 节点数 > 500 | 按 kind 分区 + 只对 claims ≥ 3 的节点建目录 |
| 分页预取浪费 | 预取命中率 < 40% | 预取上限 3 条；命中率进指标，低于阈值关掉预取 |
| 中文分词策略变更 | 索引与查询不同步 | `bg` 列由同一函数生成；改分词必须整表重建索引，迁移脚本带 `rebuild_fts` |
| 检索工具被滥用 | > 2 次/轮 | 硬上限 + 每次 ≤200 token |
| Distill 成本失控 | > 1 次 LLM/轮 | 批量 + 只对有新信息的轮；兜底 M0 纯规则 |
| `node:sqlite` 变动 | 升级后报错 | `engines: ">=22.19 <23"` + CI 冒烟 |

---

## 11. 技术选型

| 选择 | 理由 |
| --- | --- |
| `node:sqlite`（Node 22 内置） | 零依赖；v22.22.1 验证 `DatabaseSync` 可用（ExperimentalWarning） |
| FTS5 + bigram 列 + `bm25()` | 稀疏检索 + 权重，全部可 `EXPLAIN`。**trigram 分词器实测不可用**（2 字词命中 0），故自建 bigram |
| `zlib.zstdCompressSync` | v22.22.1 验证可用；L0 压缩 5–10× |
| AES-256-GCM（`node:crypto`） | epoch 加密，密文进哈希链 |
| SHA-256（`node:crypto`） | 内容幂等 + 外部引用比对 |
| 不引入 ORM | 表少；ORM 会掩盖索引问题 |
| Cordis 插件 | 与其他 DSH 插件同级，可随时关 |
| 评测走真实 API | 只有 `usage.prompt_tokens` 是账单口径（chars/4 低估 2.08×） |

---

## 12. 完成定义

1. 对话发生 → Capture 零 LLM 落 L0（脱敏 + epoch 加密 + 哈希链）
2. 空闲时先抽 must_keep → Distill 产出 `body + aiw`（受约束生成）
3. 提取外部引用（有就提）→ Gate 通过 → 入 L1
4. 提问 → 三问 → Outline/BM25 定位 → 分页给指针 → 按需取 AI文 → 渲染（≤400 token）
5. 引用文件变化 → claim 标 stale、降权、注入时提示
6. 回答后 Settle 记账
7. 30 天模拟后记忆总量收敛
8. 销毁任一 epoch → 该段不可读，链仍可验
9. QA ≥ 90%，三种渲染分别达标
10. `loom export` 可重放

**任何一条断了，这版不算完成。**

---

## 13. 交付节奏

```
W1──W2──W3──W4──W5──W6──W7──W8
骨架 存储 闸门 召回 渲染 衰减 守护 发布
 │    │    │    │    │    │    │    │
 └可跑─┴可存─┴可信─┴可得─┴可读─┴可忘─┴可删─┴可发
```

每周结束都能装进 DSH 用，能力递增。不做大爆炸式发布。
