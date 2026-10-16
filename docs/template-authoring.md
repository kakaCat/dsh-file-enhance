# 模板文档设计（file-format-specs 的 `template`）

> 状态：**设计稿**。校验实现见 `src/content-format/`；本文只定义「模板文档长什么样、受什么约束」。

## 0. 模板文档是什么

一份 `.md`，放在 `.dsh/file-format-specs/templates/` 下（与同名 `.yaml` 一台一档），由 spec 的 `template:` 字段引用。
同一份文件同时充当四个角色：

| 角色 | 谁在用 |
|---|---|
| 人读的文档骨架 | 项目成员 |
| **agent 的目标**（打回时原样注入） | `renderFormatGuidance` 的【目标模板】 |
| 结构比对基准 | `templateSections` 原语（模板的 H2 → 文档必须包含） |
| 可直接通过的空白稿 | 复制+替换占位符即 `accept` |

**核心不变量**：模板自身是一份**合法文档**——把占位符填掉就能通过它对应的 spec 的**结构规则**（内容规则如「必须有 owner」由填写满足）。规则与模板是同一结构的两种表达，不允许漂移。

### 0.1 目录布局：模板独立成文件夹

**一个文档类型一个文件夹**：规范、骨架、示例同处一类：

```
.dsh/file-format-specs/
  <type>/                     # 目录名 = 类型名
    spec.yaml                 # 规范：匹配 + 规则（name 默认取目录名）
    template.md               # 骨架：结构 + 提示（template 默认取本文件）
    example.md                # 填好的参考（打回时只给路径指针，不内联正文）
```

**约简**：`name` 不写就是目录名；`template` 不写就是同目录 `template.md`（存在时）。加载器只认类型子目录
（`_` 前缀 = 草稿，跳过），见 [spec.ts](../src/content-format/spec.ts) 的 `typeDirs` / `readSpecDir`。

## 1. 结构契约（模板 ↔ 规则一一对应）

| spec 里的声明 | 模板里的对应物 | 匹配语义（源码） |
|---|---|---|
| `frontmatterRequired: {keys}` | 首个 `---` 块里的键 | 键名精确匹配 |
| `sectionsRequired: {headings}` | `## ` 标题 | **归一化后精确相等**（去编号/括注/`serves:`），`level === 2` |
| `sectionsRequired: {order: true}` | 标题出现顺序 | 顺序比较 |
| `tableRequired: {under, header, min_rows}` | `under` 节**之后**的表格 | `under` 归一化精确匹配；表头单元格 `includes`，数据行数 |
| `templateSections` | 模板自身的 H2 集合 | 文档 H2 归一化后包含模板每个 H2 |
| `ids: {prefixes, unique, sequence}` | 至少一个合法编号实例（如 `FR-1`） | 行首 `PREFIX-n` |
| `forbiddenText / requiredText` | 正文关键词 | `bodyLines.includes` |
| `size: {max_lines, max_chars}` | 整体篇幅 | 行数 / 字符数 |

> 层级选择：`##` 是被结构规则检查的层级；`#`（H1）只有一份，`###` 用于编号实例（`FR-1: …`，`ids` 会扫加粗/行首）。

> **frontmatter 分两层**：`title` / `status` 是硬字段（`frontmatterRequired`），`status` 还有值域（`frontmatterEnum`）；
> `owner` / `owner_team` 由函数判（`owner || owner_team`，**不强制是哪一个**）；`reviewers` / `created` / `updated` 目前只作展示——
> 解析器把它们**当字符串**（YAML 列表 `[...]` 不会解析成数组），所以模板里写标量、别写列表。

## 2. 占位符语法（提议冻结）

| 语法 | 含义 | 处理 |
|---|---|---|
| `<中文占位>` | **必填值**（标题、产品名、模块名） | agent 必须替换 |
| `（说明：…）` | **填写提示**，解释这一节写什么 | agent 必须替换或删除 |
| 编号 `R-1` / `FR-1` | 最小合法实例 | agent 按需扩展，保持连号唯一 |
| 空行 / 留白 | 待补内容 | agent 补齐 |

**禁止残留**：未替换的 `<…>`、`（…）`，以及 `TODO / TBD / 待补充`。

> 为什么统一用尖括号 + 全角括号：模板要能**直接过结构校验**（章节/表头/编号都在），
> 又要一眼看出「哪些不是真内容」。占位符由**独立规则**拦截（建议 `noPlaceholder`，
> 见 §5），而不是靠结构规则——结构与内容是两件事。

## 3. 组织规则

1. **第一个 `---` 块就是 frontmatter**，键顺序照 `frontmatterRequired.keys`；不写多余键。
2. **H2 标题归一化后与要求精确相等**（去编号 / 括注 / `serves:` 标注）；所以 `## 非功能需求` 不会再被 `功能需求` 误命中。
3. **表格紧跟所属 `##` 节**（`tableRequired.under` 靠行号定位到节之后的第一张表），表头列名与 `header` 对齐。
4. **编号实例给一个就够**：`sequence` 只检查已出现编号之间的空洞，单个 `FR-1` 合法。
5. **提示写成全角括号行**，不要用 HTML 注释——`<!-- -->` 会进 `bodyLines`，可能误触 `requiredText` / `forbiddenText`。
6. **不要放代码围栏**：解析器跳过围栏，但 agent 会原样保留。

## 4. 反模式

| 反模式 | 后果 |
|---|---|
| 模板里放假数据（真实公司名、看似成品的段落） | agent 照抄 |
| 章节名与 `sectionsRequired` 不一致 | `templateSections` 报错 / 结构漂移 |
| 用 `## 背景与目标` 同时顶 `背景` 和 `目标` | 精确匹配下两个要求都不满足——这是好事：逼你拆成两个节 |
| 表格放在错误节之后 | `tableRequired` 找不到表 |
| 用长模板超 `max_chars` | 自己过不了自己 |

## 5. 校验闭环与守护

```
模板（设计期）
   │  copy + 替换占位符
   ▼
文档（运行期）──validateDocument──► 符合 → accept
   │                              不符合 → block（注入【目标模板】+ 差异清单）
   └─ 占位符残留 ──noPlaceholder──► block（提示「模板未改」）
```

建议补的三件事（实现层面，待定）：

1. **守护测试（已实现）**：遍历 `examples/file-format-specs/`，对每份 `template`，
   `validateDocument(templateText)` 必须**零 error**——「模板落笔即合规」（见 `test/format.test.ts`）。
   将来若启用 `noPlaceholder`，该条对它豁免（模板注定含占位符）。
2. **`noPlaceholder` 规则**：内置原语或示例 `function`，拦 `<[^<>\n]+>` 与未替换的 `（…）`，
   统一报「模板占位符未替换」。
3. ~~**`file_rules_init` 同时落模板**：冷启动时 `.yaml` 与 `.md` 成对出现，避免有规则无模板。~~
   **已作废（2026-10-15）**：`file_rules_init` 随工具面收敛删除；冷启动改为手工「复制 `examples/md.yaml`
   + 复制 `examples/file-format-specs/<type>/`」两步，成对落盘由复制动作本身保证。

## 6. 示例（现成模板的定稿草案）

按**工作流环节**逐个设计，每个类型三件套：`spec.yaml`（判据）+ `template.md`（形状）+ `example.md`（实例）。
下游文档一律是上游某一节的**展开件**，并且必须能顺着编号反向指回去：

```
research（Q-x / E-x / D-x）--> requirement（R-x）--> prd（FR-x / NFR-x）--> design（serves: FR-x）--> metrics（M-x / EV-x）
        |                              |                    |                    |
        +-- 结论含成立与翻转条件        |                    |                    +-- 接口 IF-x、四风险证据
        +-- 证据分级 A/B/C/D            +-- 需求池含被拒与延期项
```

编号链是**单向向下**的：调研给出 D-x（要不要做）→ requirement 给出 R-x（诉求是否成立）→ prd 给出 FR-x / NFR-x（做什么）
→ design 给出 IF-x（怎么做）→ metrics 给出 M-x / EV-x（怎么衡量）。每一环都要能顺着编号指回上游，指不回去的说明有一份该更新了。

### requirement.md

**需求池**——**PRD 的上游**。PRD 回答「选中的这个功能做什么」，本文回答「这些诉求本身成立吗、凭什么排在前面、哪些已经决定不做」。
实际文件见 [examples/file-format-specs/requirement/template.md](../examples/file-format-specs/requirement/template.md)，
规则见 [requirement/spec.yaml](../examples/file-format-specs/requirement/spec.yaml)。13 节与来源对应：

| 节 | 来源 |
|---|---|
| 摘要（要解决什么 / 来源与证据强度 / 本轮结论） | 全文 TL;DR，结论必须点数：进几条、拒几条、延期几条 |
| 背景与来源（收集方式 · 样本 · 原始记录） | **Amazon 从客户倒推**：写不出证据的不是需求，是偏好 |
| 干系人与角色（角色 · 关注点 · 影响程度 · 决策权） | Wiegers 干系人分析：提的人、受影响的人、拍板的人常常不是同一批 |
| 待解问题（问题 · 证据 · 影响 · 谁受影响） | **Wiegers 的顺序：先问题，后需求**——需求是对问题的回答 |
| 假设与风险（假设 · 如果错了会怎样 · 证伪方式 · 结论） | **Cagan 机会评估**：最危险假设要能用最便宜的方式证伪，「结论」写实测结果 |
| 需求清单（编号 R-x · 需求陈述 · 类型 · 优先级 · 状态） | 需求属性：**状态含被拒与延期**——池子不只装活下来的 |
| 需求明细（**描述 / 来源与证据 / 验收判据 / 优先级理由 必填**，依赖与假设 / 不做的后果按需） | Wiegers 需求属性 + 可验证性；「来源与证据」是 Must 的资格线 |
| 优先级与排序（排序方法 · 判据 · 本轮结论） | 排序方法要写出来，不能只给结果（MoSCoW / WSJF / RICE 选一种） |
| 需求验证（需求编号 · 验证方式 · 结论 · 验证人） | **Wiegers 需求验证**：只写「已评审」不算验证，要写清用什么核对过 |
| 变更控制（日期 · 变更 · 谁提的 · 决策 · 影响） | Wiegers 基线变更控制：口头改需求是这类文档最常见的失效方式 |
| **与 PRD 的映射（需求编号 · PRD 需求编号 · 状态）** | 两份文档之间的链；一个 R-x 可拆多条 FR-x，被拒的也要出现 |
| 开放问题（问题 · 选项 · 负责人 · 截止） | Google Open Questions |
| 附录（原始记录 · 相关文档 · 变更历史） | 定稿后冻结为基线，后续变更走「变更控制」 |

**这份 spec 比 prd 多做的三件事**：

1. **优先级词表是机器判据**（script 函数 `priorityVocabulary`）：`优先级` 列必须是 `Must / Should / Could / Won't`。
   「高 / 中 / 低」既无法机械排序，也无法和 PRD 对齐——出现即打回。这是「词表约束」这类判据的第一个例子。
2. **需求池必须留痕被拒与延期**：状态列与「与 PRD 的映射」表要求被拒项写「无（见非目标）」。三个月后能回答「为什么没做」。
3. **两个入口表都在前面**：待解问题与假设与风险排在需求清单之前，逼作者先写问题与证据，再写需求。

> 与 prd 的接缝：`R-x` 是 PRD 里 `FR-x` / `NFR-x` 的来源编号；PRD 的「成功指标」再展开成 metrics 的 `M-x`。
> 三份文档的编号必须互相指得着，任何一处对不上都说明有一份该更新了。

实际示例见 [examples/file-format-specs/requirement/example.md](../examples/file-format-specs/requirement/example.md)
——与 PRD / 设计示例同一套题材（R-1～R-8 → FR-1～FR-6 / NFR-6），其中 R-7 被拒、R-8 延期，可直接看「池子留痕」长什么样。

### prd.md

**已按业界标准重做**——不再是 4 节的薄模板。实际文件见
[examples/file-format-specs/prd/template.md](../examples/file-format-specs/prd/template.md)，
规则见 [prd/spec.yaml](../examples/file-format-specs/prd/spec.yaml)。19 节与来源对应：

| 节 | 来源 |
|---|---|
| 摘要 | 全文 TL;DR |
| **发布公告**（标题 / 副标题 / 客户问题 / 用户原话） | **Amazon PR-FAQ：先写发布稿** |
| 背景与问题（现状·问题·影响与证据） | Cagan / Wiegers 的 Problem Statement |
| 目标与非目标 | Google 设计文档 Goals & Non-Goals |
| 成功指标（指标·基线·目标·时间窗·衡量方式） | OKR / Cagan 的 Key Results |
| 目标用户与场景 | 经典 PRD User Personas |
| 用户旅程与流程设计（参与者 / 编号步骤 / ASCII 图 / 状态表 / 异常恢复 / 需求追踪） | Wiegers Use Cases & Process Flows + Visual Models |
| 原型与交互说明（页面原型条件式链接 / 文本交互原型 / 图与清单 / 可用性验证） | Cagan Usability Risk + Wiegers Visual Models |
| 功能需求 = 需求清单 + 需求明细（每条 FR **必填** 描述 + 验收标准 AC-x.y Given-When-Then；业务规则 BR-x.y / 异常与边界 / 不在本期范围 **按需**，写了就不能空） | Wiegers Functional Requirements + MoSCoW + BDD |
| 非功能需求（性能/可靠性/安全/隐私/可观测性/兼容…） | Wiegers NFR + Google Cross-Cutting |
| 边界与异常路径 | Wiegers Edge Cases + 失败与并发 |
| 约束与依赖 | 经典 PRD Constraints |
| 风险与缓解（含**最危险假设 + 验证方式**） | 经典 PRD Risks + Amazon「最怕的问题」 |
| **常见问题**（客户 FAQ + 内部 FAQ：为什么现在 / 为什么我们 / 要砍砍哪块） | **Amazon PR-FAQ：FAQ** |
| 备选方案 | Google 设计文档 Alternatives Considered |
| 发布与回滚（含可观测性 / 运维归属） | Google Cross-Cutting：Rollout / Rollback / Observability / Ownership |
| **时间线**（里程碑 / 时间 / 依赖） | Cagan / Wiegers Timeline |
| 开放问题（问题 / 选项 / 负责人 / 截止） | Google Open Questions |
| 附录（含审批记录 / 变更历史） | 经典 PRD Appendix + Google metadata |

实际示例见 [examples/file-format-specs/prd/example.md](../examples/file-format-specs/prd/example.md)
——主题就是本规则引擎本身，可作为「填到什么深度」的参照。

### design.md

**设计文档**——PRD 说完「做什么、为什么」，本文回答「怎么做、为什么这么做、坏了怎么退」；它同时是 Design Review 的**评审对象**（会前发出、评审人逐条批注、结论定级）。
实际文件见 [examples/file-format-specs/design/template.md](../examples/file-format-specs/design/template.md)，
规则见 [design/spec.yaml](../examples/file-format-specs/design/spec.yaml)。16 节与来源对应：

| 节 | 来源 |
|---|---|
| 摘要 | 全文 TL;DR（问题 / 方案 / 影响面） |
| 背景与问题（需求来源 · 现状与代价 · 为什么是现在） | **Amazon 从客户倒推** + **Wiegers 需求出处**（需求从哪来、原话是什么、有没有被改写） |
| 目标与非目标（非目标 ≥3 条） | **Google Goals & Non-Goals**：写不出非目标 = 范围没想清 |
| 方案总览（一句话方案 + 上下文图 + 关键概念） | Google Context & Scope：图只表达结构，正文要能独立读懂 |
| 架构与依赖（模块 / 依赖方向 / 外部依赖 / 与既有架构差异） | 经典设计文档 + 依赖失效时的降级行为 |
| 数据模型（实体 · 约束 · 迁移与回填 · 生命周期） | 工程实践：涉及存量数据必须写迁移、回填与回滚 |
| **接口设计 = 清单表（编号 IF-x） + 明细（语义 / 错误码 / 兼容性 必填，幂等与重试按需）** | **契约优先**：机器可读部分（proto / OpenAPI / 类型定义）是真源，本文只写它表达不了的语义 |
| 备选方案（≥2 个，含「什么都不做」） | **Google Alternatives Considered**：为什么未选要写代价 |
| 四风险与证据（价值 / 可用性 / 可行性 / 商业可行性） | **Cagan 四风险**：写证据不写判断，没证据就写「未验证」 |
| 失败模式与回滚（失败场景 · 检测手段 · 回滚动作 · 决策人 + 开关 / 演练 / 不可逆动作） | **Amazon 内部 FAQ**：最坏会怎样、怎么发现、怎么退回来 |
| 跨关注点（安全 / 隐私 / 成本 / 可观测性 / 性能容量 / 文档支持） | **Google Cross-Cutting Concerns**：逐项给结论，不许留空 |
| 交付拆分与里程碑（出口判据 + 契约冻结点） | 拆分必须各自可验证，不写「完成开发」 |
| 需求追溯（需求 ↔ 设计节 ↔ 测试 ↔ 指标） | **Wiegers 追溯**：对不上的，要么需求该删，要么设计漏了 |
| 常见问题（内部 FAQ ≥6 问） | **Amazon 内部 FAQ**：最可能被投诉什么 / 6 个月后成什么负担 / 涨 10 倍先坏哪 / 谁半夜被叫起来 / 数据错了怎么修 / 错了多久能发现 |
| 开放问题（问题 · 选项 · 负责人 · 截止） | **Google Open Questions** |
| 附录（原型与验证材料 · 相关文档 · 评审记录 · 变更历史） | 评审结论定级后冻结为基线，变更出新版本 |

**这份 spec 比 prd 多做的三件事**：

1. **章节级追溯扩到全 H2**：每个 `##` 都带 `serves:`（指向 `FR-x` / `NFR-x`，全文性章节写「全文」）。
   口径是 **只查 H2**——结构契约的层级是 H2；H3 是节内小节、H4 是编号实例（`#### IF-1`），都不要求 serves。
2. **接口是「清单 + 明细」双件套**（`idDetails`）：`IF-x` 必须先在清单表出现、必须有同名明细小节，
   且 `语义 / 错误码 / 兼容性` 三节缺一即打回——把「接口改动有没有考虑失败语义与兼容性」变成机器判据。
3. **`at-least-one-interface`**：设计至少要有一条可评审的契约（`IF-1…`）。一个接口都写不出来的「设计」，通常只是还没想清楚。

> 与 prd / metrics 的接缝：PRD 的 `FR-x` 是 design 的 `serves:` 标注与「需求追溯」表的锚点；
> design 的「需求追溯」表引用 metrics 的 `M-x` 作为指标落点。三份文档的编号必须互相指得着。

实际示例见 [examples/file-format-specs/design/example.md](../examples/file-format-specs/design/example.md)
——题材就是本规则引擎本身（与 PRD 示例同一套 FR-1～FR-6 / NFR-1～NFR-6），可作为「填到什么深度」的参照：
接口表 4 行 `IF-1～IF-4` 各有明细，四风险逐项给证据，失败模式表每行都指到决策人。

规则本身有负例探针（缺 serves / 清单有编号缺明细 / 明细缺「错误码」/ 一个 IF 都没有），
见 [test/format.test.ts](../test/format.test.ts) 的「示例规范守护」——确认它「会拦人」而不是「恰好通过」。

### metrics.md

**埋点与指标方案**——PRD 里「成功指标」那一节的展开件，也是「PRD 写完以后还要写什么」清单里的第 3 份。
实际文件见 [examples/file-format-specs/metrics/template.md](../examples/file-format-specs/metrics/template.md)，
规则见 [metrics/spec.yaml](../examples/file-format-specs/metrics/spec.yaml)。14 节与来源对应：

| 节 | 来源 |
|---|---|
| 摘要 | 全文 TL;DR（服务哪个决策 / 覆盖哪次发布 / 谁按什么节奏看） |
| 目标与决策用途（决策 · 依据指标 · 达标 / 不达标动作） | **Google Goals**：改变不了决策的指标不写 |
| 假设与风险验证（含四风险各一行） | **Cagan 四风险**：价值 / 可用性 / 可行性 / 商业可行性，写成可证伪假设 |
| 指标框架（HEART 维度 · 目标 · 信号 · 指标 · 服务风险） | **Google HEART + Goals→Signals→Metrics**（Rodden 等） |
| 指标体系（北极星 · 输入 · 诊断 + 是否可干预） | **Amazon 输入 / 输出指标**：输出看结果，输入可控且领先 |
| 指标定义 = 总览表（编号 M-x + 基线 / 目标 / 时间窗 / 阈值）+ 明细（**定义 / 计算口径 / 数据来源 / 验证方式 必填**，分段 / 已知偏差按需） | **Wiegers**：指标也是需求，要可量化、可验证、两人算出同一个数 |
| 反指标与护栏（阈值 + 触发动作） | Google **counter / guardrail metrics**：只盯一个数必然以没在看的方式变坏 |
| 埋点清单（编号 EV-x · 事件名 · 触发时机 · 关键属性 · 上报方式 · 隐私等级 · 负责人 + 命名规范） | 工程实践：**埋点先于功能进 DoD**，缺事件即缺数 |
| 实验与灰度设计（实验单元 / 分流 / 样本量与 MDE / 最短时长 / **OEC** / 停止规则，每项给理由） | **Google OEC 与实验设计**：判定规则要在看数之前写下来 |
| 数据链路与质量（环节 · 数据源 · 延迟 · 校验规则 · 断流告警） | 可观测性：链路每一跳可查、断流有人知道 |
| 看板与复盘节奏（每日 / 每周 / 上线后 N 天 + 触发动作） | **Amazon WBR**：固定节奏、看趋势、异常必须给归因与行动项 |
| 上线验收与签署（验收项 · 合格标准 · 验证方式 · 负责人 + 具体签署人） | Google Launch 前置：埋点是发布的一部分，不合格不许上线 |
| 开放问题（问题 · 选项 · 负责人 · 截止） | Google Open Questions |
| 附录（PRD / 设计文档 · 看板 · 变更历史） | 口径变更留痕 |

**这份 spec 比 prd/design 多做的两件事**（都在 [metrics/spec.yaml](../examples/file-format-specs/metrics/spec.yaml) 里）：

1. **编号化的指标明细**（`idDetails`）：`M-x` 必须在总览表里出现、必须有同名明细小节，且
   `定义 / 计算口径 / 数据来源 / 验证方式` 四节缺一即打回——把「两个人算出同一个数」变成机器判据。
2. **指标 ↔ 埋点双向追溯**（`metricEventTrace` script 函数，引擎的逃生舱口）：

   | 方向 | 判据 | 不满足时的报错 |
   |---|---|---|
   | 指标 → 埋点 | 每个 `M-x` 的明细至少要引用一个 `EV-x` | `M-1 的明细没有引用任何埋点编号（EV-x）` |
   | 埋点 → 指标 | 每个 `EV-x` 至少被一个指标明细引用 | `EV-2 没有被任何指标引用：埋点要么删掉，要么补上它服务的指标` |

   这两条正好拦住最常见的两种烂尾：指标没有数、埋点没人用。规则本身也有负例探针（缺章节 / 乱序 /
   缺明细字段 / 追溯断裂 / 缺列 / 少行 / 缺 owner）逐条验过，确认「会拦人」而不是「恰好通过」。

> 与 prd 的接缝：PRD 的「成功指标」表给的是**基线 / 目标 / 时间窗 / 衡量方式**（要做什么），
> 本文给的是**口径 / 数据源 / 验证方式 / 埋点编号**（怎么算出来的）。两份文档的指标名必须能一一对上。

### research.md

**调研报告**——**需求池的上游**（PRD 的上游是 requirement，requirement 的上游是这份）。PRD 说「做什么」，
设计说「怎么做」，本文回答「**这个结论凭什么成立**」：证据是什么、缺什么、什么条件下结论会翻转。
实际文件见 [examples/file-format-specs/research/template.md](../examples/file-format-specs/research/template.md)，
规则见 [research/spec.yaml](../examples/file-format-specs/research/spec.yaml)。11 节与来源对应：

| 节 | 来源 |
|---|---|
| 摘要（调研问题 / 办法 / 结论 / 证据强度 / **这份调研不能用来决定什么**） | Google 研究文档 TL;DR + 结论外推边界 |
| 背景与调研问题 = 决策背景 + **问题清单（Q-x）** + 问题明细（**决策影响 / 调研与证据 必填**，反证按需） | **Amazon Working Backwards**：先写清「要让谁做什么决定」，再决定去查什么 |
| 调研方法与范围界定（方法 · 做法 · 样本 · 时间窗 · 局限 + 纳入 / 排除 / 不做的事） | **McKinsey MECE**：方法、样本、时间窗写在前面，读者才能判断能外推到哪 |
| **决策与结论（D-x · 要做的决定 · 决策人 · 截止 + 当前建议）** | 决策人只看这一节也能做决定；D-x 是全文锚点 |
| **证据索引（E-x · 证据 · 来源分级 · 获取方式与日期）** | **McKinsey 证据分级**：A 官方 / B 实测 / C 二手 / D 主观，别人能照着重查 |
| 关键发现（**发现 · 支撑证据 · 事实或推断 · 可信度**）+ 与直觉相反的地方 | 结论与事实分离：混写是调研失效的主要原因 |
| 方案对比矩阵（维度 · 权重 · 各候选打分 · **标注**） | 同一口径逐项打分；缺依据的格子写「无证据」，不许留空 |
| 结论与建议（**结论 · 立场 · 成立条件 · 翻转条件** + 不采纳的方案与理由） | 写不出翻转条件的结论不是结论，是偏好 |
| 风险与不确定性（**最危险假设** + 信息缺口 · 影响哪个结论 · 获取成本 · 处理方式） | 没写出来的盲区不会自己消失 |
| 开放问题（问题 · 选项 · 负责人 · 截止） | Google Open Questions |
| 附录（访谈与问卷 · 实测脚本与原始数据 · 相关文档 · 评审记录 · 变更历史） | 原始材料与结论翻转留痕 |

**这份 spec 比 prd / design / metrics 多做的三件事**：

1. **证据分级是机器判据**（`evidenceClass` script 函数）：证据索引表的「来源分级」列只认 `A / B / C / D`，
   且整份报告**至少要有一条 A 或 B**。「都是二手总结 + 主观判断」的调研不许落盘——
   这是「词表约束」在证据维度上的用法，和 requirement 的 MoSCoW、research 自身的立场词表同一手法。
2. **问题 ↔ 证据双向追溯**（`questionEvidenceTrace`）：每个 `Q-x` 的明细必须引用至少一个 `E-x`（问题不能是拍脑袋的）；
   每条 `E-x` 必须至少被一个 `Q-x` 引用（查完没人用的证据该删）。

   | 方向 | 判据 | 不满足时的报错 |
   |---|---|---|
   | 问题 → 证据 | 每个 `Q-x` 的明细至少引用一个 `E-x` | `Q-1 的明细没有引用任何证据编号（E-x）` |
   | 证据 → 问题 | 每条 `E-x` 至少被一个 `Q-x` 引用 | `E-4 没有被任何调研问题引用` |

3. **结论立场词表**（`decisionVocabulary`）：`立场` 列只认 `采纳 / 不采纳 / 有条件采纳 / 继续调研`。
   「建议采纳 / 再想想 / 看情况」无法被下游引用，也无法机械判断「结论到底给了没有」。

> 一个实现细节值得记下来：spec 的**计数类判据必须数表格的行，不能数全文里编号的出现次数**。
> 最初用 `countIds: [["E"]]` 判「证据至少两条」，结果一条证据被引用 6 次也算 6 条——
> 于是改成 `derive` 从 `doc.tables` 里取证据索引表的行（`researchEvidenceCount`）。
> 另外，用户脚本的上下文只注入 `doc / text / api`（白名单），**看不到同一个 spec 里的其他函数**，
> 所以 `findTable` 这种三行小工具要在每个脚本里自带一份，不能跨函数复用。

实际示例见 [examples/file-format-specs/research/example.md](../examples/file-format-specs/research/example.md)
——题材就是这个插件自己（「要不要给 dsh-file-enhance 加内容格式校验子系统」），
含 Q-1～Q-4、E-1～E-6（A 级 2 条 / B 级 2 条 / C 级 2 条 / D 级 1 条）、D-1～D-3 与信息缺口表，
可作为「一份能被复核的调研」长什么样的参照。规则本身有负例探针（立场不在词表 / 缺来源分级 /
只有 C·D 级证据 / 问题没引用证据 / 证据没人用 / 证据不足两条 / 缺章节），见
[test/format.test.ts](../test/format.test.ts) 的「示例规范守护」。

> 与下游的接缝：research 的 `D-x`（要不要做）→ requirement 的 `R-x`（诉求是否成立）→ PRD 的 `FR-x`（做什么）。
> 调研的结论里「翻转条件」一旦被触发，下游三份文档都要更新——这是编号链存在的意义。

## 7. 与「目标结构骨架」的关系

spec 没有 `template` 时，[skeleton.ts](../src/content-format/skeleton.ts) 从规则反推骨架。
那是**兜底**：只画得出 frontmatter / H2 / 表头，画不出每节该写什么。
**有模板时一律以模板为准**——模板是作者手写的、带上下文的目标，比机器拼的骨架强。

---

## 8. 参考 dsh-pmboard 的模板设计：采纳 / 不采纳

pm 的模板体系在 `dsh-pmboard/templates/`，比我们成熟。它的**部署形态和我们不同**（pm 是插件内置、随包发行；我们是在用户工作区里手写），所以有的直接抄，有的要改造。

### 8.1 pm 做对了什么

| pm 的做法 | 出处 |
|---|---|
| **模板是唯一事实源，与门禁同源设计**（"落笔即合规"） | `templates/README.md` |
| **双向对齐探针**：门禁必填节集合 == 模板 H2 集合，**双向相等**，哪边多/少都 exit 1 | `scripts/doc-section-parity.mts` |
| **骨架与示例分离**：`<doc>.md` 骨架 vs `examples/<doc>.example.md` 填好的参考 | `templates/examples/` |
| **提示内联在骨架里**：`（…）` 提示 + `❌ 错误 / ✅ 正确` 示范 + 三要素 checklist | `templates/brainstorming/feature.md` |
| **常驻只放指针**：模板地址 + 一句话用途，**正文不进 prompt**，agent 自己 `read` | `src/domain/template/render.ts` |
| **按节点组织**：`templates/<stage>/<doc>.md`，一行映射到落盘路径 | `domain/template/registry.ts` |
| **幂等落盘**：不存在才写，永不覆盖 | `templates/README.md` |
| **防漂移**：六份需求模板通用区逐字一致，机械比对 | `templates/README.md` |
| **精确节名匹配**：标题行 = 节名（可带编号/括注），改名即不合规 | `hasRootSection` |
| **行内追溯** `serves: FR-x`（章节级，单一来源） | `TEMPLATE-IMPROVEMENTS.md` |

### 8.2 直接采纳（映射到我们）

1. **模板 ↔ 规则双向对齐**：现在 `templateSections` 只做「文档 ⊇ 模板」，单向。照 pm 改成**模板 H2 集合 == 结构规则要求的节集合**，任何一边多一节都报——防「模板多写一节没人管」和「规则要求一节模板里没有」两种漂移。
2. **骨架 + 示例 双件套**：新增 `example:`。骨架给**形状**，示例给**内容深度**——这正是你说的「agent 不知道怎么改」的正解。
3. **提示内联骨架**：`（说明：…）` + `❌/✅` 示范，照 pm `feature.md` 的写法；残留由 `noPlaceholder` 拦。
4. **精确节名匹配**：把 `sectionsRequired` 从 `includes` 收紧为「去掉编号/括注后判等」，消除 `## 背景` 命中 `## 背景与目标` 的歧义（pm 的 `hasRootSection` 口径）。
5. **打回文本附模板地址**：给相对路径，让 agent 能自己 `read` 全文（pm「先读再动手」）。
6. **成对落盘**：冷启动复制示例时 `.yaml` + `.md` 一起复制（原想由 `file_rules_init` 代劳，该工具已于 2026-10-15 删除）。

### 8.3 不采纳（部署形态不同，硬抄会坏）

| pm 的做法 | 为什么不抄 |
|---|---|
| md 源 → 构建期 inline 成 `generated/templates.ts` | 我们的模板在**用户工作区**、用户可随时改，编译不进包 |
| `{{REQ_ID}}` 这类**代码自动填充**的占位符 | 我们没有 pm 的台账数据源；我们的占位符由 agent 填，保留 `<中文>` |
| HTML 注释 `<!-- serves: -->` 做标注 | 我们的解析器把注释算进 `bodyLines`，会误触 `requiredText/forbiddenText`；要用得先让 parser 剥离注释 |
| 按流程节点分文件夹 | 我们的维度是**文档类型**（`<name>.yaml/.md`），不是流水线节点 |
| 硬门/软门分层 + 存量分期不追溯 | 概念已有对应（`severity: warning` + `diff_mode: delta`），不需要 pm 那套复杂度 |

### 8.4 建议的 schema 扩展

```yaml
# .dsh/file-format-specs/prd/spec.yaml
match: [prd, 产品需求]
# name 默认 = 目录名 "prd"；template 默认 = 同目录 template.md；example 默认 = 同目录 example.md
```

有示例时，打回文本变成：

```
【目标模板（prd.md）】      ← 骨架：改成什么形状
【填写参考（prd.example.md）】← 示例：填到什么深度
【模板地址】.dsh/file-format-specs/prd.md（可用 read 打开全文）
```

### 8.5 要你拍板的四个分叉

| # | 分叉 | 选项 | 我的倾向 |
|---|---|---|---|
| 1 | 加 `example:` 吗 | 加 / 不加 | **加**——直接解「agent 不知道改成什么样子」 |
| 2 | 节名匹配口径 | 保持 `includes` / 收紧为精确 | **精确**——消除 `背景` vs `背景与目标` |
| 3 | 大模板怎么注入 | 全文内联 / 指针 + 清单 | 小模板内联、超阈值（如 60 行）转指针；总是附地址 |
| 4 | 双向对齐落在哪 | 运行时规则 / 开发期守护 | **开发期守护测试**（照 pm 探针）；原设想的 `file_check` 巡检已随工具面收敛删除 |


## 9. 参考来源（PRD / 指标体系结构依据）

- **Google 设计文档**（Malte Ubl, *Design Docs at Google*）：Context & Scope / Goals & Non-Goals / Alternatives Considered / Cross-Cutting Concerns / Open Questions —— [industrialempathy.com](https://www.industrialempathy.com/posts/design-docs-at-google/)
- **Amazon PR-FAQ / Working Backwards**：先写发布新闻稿 + 客户 FAQ + 内部 FAQ，用"客户会不会想要"倒推 —— [aboutamazon.com](https://www.aboutamazon.com/news/workplace/working-backwards)
- **经典 PRD 写作**（Cagan / Wiegers《Software Requirements Essentials》）：Problem Statement / Goals & Metrics / Personas / Functional & Non-Functional / Edge Cases / Risks / Appendix —— [traditional-prd-writing.md](https://github.com/vasilyu1983/AI-Agents-public/blob/main/frameworks/shared-skills/skills/docs-ai-prd/references/traditional-prd-writing.md)
- **MoSCoW 优先级**：Must / Should / Could / Won't，用于功能需求表的优先级列。

### metrics.md 额外用到的来源

- **HEART + Goals→Signals→Metrics**（Rodden, Hutchinson, Fu, *Measuring the User Experience on a Large Scale*，Google）：Happiness / Engagement / Adoption / Retention / Task Success，先目标后信号最后才是指标。
- **OEC 与实验设计**（Tang 等，*Overlapping Experiment Infrastructure*，Google）：Overall Evaluation Criterion、分流单元、样本量与最小可检测效应、分流比例检查（SRM）、在看数之前写下停止规则。
- **Amazon 输入 / 输出指标 + WBR**：关注可控的输入指标，输出指标只判结果；周度业务复盘固定看趋势，每个异常必须给归因与行动项。
- **Cagan 四风险**（《Inspired》）：价值 / 可用性 / 可行性 / 商业可行性，各自用最便宜的方式先证伪。
- **Wiegers 可验证性**（《Software Requirements》）：需求（含指标）必须可量化、可验证、可追溯——本文把「指标 ↔ 埋点」双向追溯写成了机器判据。

### research.md 额外用到的来源

- **Amazon Working Backwards**（同 PR-FAQ 的方法论）：先写清「要让谁做什么决定」，再决定去查什么——查不出决策影响的问题不写进清单。
- **McKinsey 问题分解与证据分级**（MECE + 证据金字塔的工程化用法）：维度不重不漏；来源按「官方文档 / 源码（A）→ 可复现实测（B）→ 二手资料（C）→ 主观判断（D）」分级，结论必须能落到 A 或 B。
- **研究报告的结论规范**（工程实践）：结论要给「成立条件」与「翻转条件」——写不出翻转条件的结论无法被后续证据推翻，也就无法被维护。
- **Wiegers 追溯思想**（同 requirement / metrics）：调研问题与证据之间也做双向追溯，本文把它写成 `questionEvidenceTrace` 判据。
