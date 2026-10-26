# LOOM

面向 DeepSeek Harness 的本地记忆层：**原文一条不丢，视图按需压缩，删除可验证。**

## 它解决什么问题

大多数记忆插件只做两件事：把上一轮的话压成摘要，下一轮塞回上下文。这有两个后果——

1. **压缩即丢失**：压掉的那部分再也找不回来
2. **不可审计**：没人能证明某条记忆没被改过、也没法真的删掉

LOOM 分成三层，各管一件事：

| 层 | 存什么 | 特点 |
| --- | --- | --- |
| **L0 原文** | 每一条消息（含寒暄、口癖、粘贴） | 追加式、SHA-256 哈希链、按 epoch 加密、可整体销毁 |
| **L1 视图** | AI文断言、项目文档、关系边 | 可检索、可压缩、可遗忘 |
| **注入** | 每轮的一小块热记忆 | 有字节上限，进每一轮上下文 |

**压缩只影响怎么读，不影响怎么存。**

## 快速开始

```bash
npm test            # 174 个测试
npm run verify      # 12 条门禁
npm run demo        # 端到端：写入 → 检索 → 取回 → 冲突 → 删除
```

插件安装（本机是软链安装，通过 DSH 的 `install_bundle` 指向 `packages/loom-dsh`）。

## 工具（16 个）

| 工具 | 作用 |
| --- | --- |
| `memory_write` | 写一条 AI文 断言（过闸门：格式 → 元数据 → 保真 → 编造） |
| `memory_note` | 原样收下用户一句话；**不会拒绝**，长文进文档 |
| `memory_recall` | 按问题取回证据，预算内正文 → 标题 → 指针 |
| `memory_outline` | 按类型看目录 |
| `memory_hot` | 看本轮注入了什么 |
| `memory_settle` | 给这一轮用到的记忆结账（涨权 / 降权） |
| `memory_decay` | 遗忘扫描（默认只预览） |
| `memory_verify` | 校验 L0 哈希链 |
| `memory_forget` | 单条失效（不物理删除，墓碑留档） |
| `memory_archive_search` | 在**原文归档**里逐字检索 |
| `memory_stats` | 账本概况 |
| `memory_diag` | 自检：本宿主里哪些服务可用 |
| `memory_doc_write` / `memory_doc_search` | 项目文档写与查 |
| `memory_link` / `memory_related` | 关系边与 BFS |

## 斜杠命令

```
/loom stats      账本概况
/loom outline    按类型列出条目
/loom verify     校验哈希链
/loom hot        看本轮注入了什么
/loom search 词  检索
```

## 侧边栏面板

五个标签：

| 标签 | 内容 |
| --- | --- |
| 状态 | 注入字节与构成、编年层（时间片 / 哈希链 / 事件数）、自动记录状态 |
| 记忆 | 断言列表，可**遗忘** |
| 归档 | 原文逐条，可**逐字搜索** |
| 文档 | 正文、**历史版本**、新建与编辑 |
| 设置 | 9 项配置、**下载 / 导入记忆包** |

回合尾部另有一行徽标：`LOOM · N 条记忆 · M 条原文归档`。

面板数据走宿主 HTTP 路由。页面可能跑在 `dsh-app://` 上，所以地址必须从 `__DSH_TRANSPORT__` 推导——**用相对路径必然失败**（这条踩过两次）。

## HTTP 路由（8 条）

```
GET  /loom/state        面板快照
GET  /loom/archive?q=   原文检索
GET  /loom/doc?id=      文档正文 + 历史版本
GET  /loom/export.zip   打包下载
POST /loom/config       改配置（写 profile）
POST /loom/forget       让一条记忆失效
POST /loom/doc-save     新建 / 更新文档
POST /loom/import       导入记忆包
```

## 配置（9 项）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `hot` | true | 每轮注入热记忆 |
| `hotBytes` | 2048 | 注入字节上限（进每一轮上下文，就是长期成本） |
| `protocol` | true | 注入「什么时候该写、该查」的协议 |
| `autoCapture` | true | 从对话里自动挑值得记的 |
| `autoCaptureLevel` | normal | `normal` 连偏好陈述一起记；`strict` 只认标识符与参数 |
| `budget` | 300 | 单次召回的 token 预算 |
| `epochDays` | 7 | L0 时间片长度（删除权的最小单位） |
| `render` | legend | 取回渲染：legend / plain / xml |
| `scope` | global | global 跟着用户走；workspace 只属于当前工作区 |

## 数据与备份

```
~/.dsh/loom/loom.db          SQLite（claim / doc / doc_rev / edge / FTS）
~/.dsh/loom/chronicle/       哈希链，按 epoch 分文件
```

```bash
loom export-zip memory.zip    # 记忆 + 文档 + 文档历史 + 关系边
loom import-zip memory.zip    # merge 模式，重复导入幂等
loom doc-revs [词]             # 看文档历史版本
loom epochs / loom shred <id> # 列出 / 销毁时间片（密钥销毁）
loom dedupe / loom migrate    # 去重 / 清理历史遗留
```

## 实测数字

**AI文 压缩**（30 条原文，DeepSeek 真 token）：

| 形态 | token |
| --- | ---: |
| 原文 | 952 |
| 碎片（旧方案） | 210 |
| 题档 | 247 |
| 轻档 | 533 |
| 全档 | 965 |
| 全档·去尾部 | **665** |

**检索质量**（200 题，`npm run retrieval`）：

| 版本 | recall@1 | recall@3 | MRR |
| --- | ---: | ---: | ---: |
| 基线 | 56.8% | 65.6% | 0.607 |
| 当前 | **64.0%** | **68.0%** | **0.659** |

剩余 31 条是词面鸿沟（问「修好的」，记的是「修复」），要靠语义召回才能补。

**规模**：5000 条记忆，单次检索 0.1ms。

**约束生成**（`npm run distill`）：闸门通过率 100%，长度与人工写作持平（1.06×）。

**归因**（`npm run settle`）：引用率 100%，词面 92%。

## 设计约束（明确不做）

- **不做多记忆空间 / 第三方 provider**——记忆一旦外包给别家，"可删除、可验证"就不再成立
- **不做技能自进化**——那是另一件事
- **不做 Git 同步**——`export-zip` + git 提交已经够，再包一层只会多一个会坏的组件
- **锁 Node 22**（`>=22.19 <23`）——依赖 `node:sqlite`，它是实验特性

## 已知限制

1. **词面检索的天花板**：同义改写的问法命中不了，64% 就是这个上限
2. **桌面模式下 `host.call` 没接上**：面板走 HTTP 路由，web 模式最完整
3. **自动捕获是规则版**：只挑"像事实/偏好"的句子，不是模型抽取
4. **回合徽标是累计量**：不是"本轮"（缺 session 消息 API）
5. **跨设备同步没有**：单机

## 开发

```
packages/loom-core/src/     26 个模块
packages/loom-core/test/    25 个测试文件（174 tests）
packages/loom-dsh/          插件（16 工具 + 面板 + 8 路由）
tools/                      8 个评测与运维脚本
```

```bash
npm test && npm run verify   # 发布前必跑
npm run retrieval            # 检索质量评测
npm run admission            # 三问第一问的收益核算
```

改动索引结构后要 `npm run reindex`（会先备份）。
