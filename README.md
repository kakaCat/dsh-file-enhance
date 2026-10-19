# dsh-file-enhance

[![CI](https://github.com/kakaCat/dsh-file-enhance/actions/workflows/ci.yml/badge.svg)](https://github.com/kakaCat/dsh-file-enhance/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

DSH 插件：**让 agent 按项目自己的规范创建文件**——不该放哪就不放哪，不该长什么样就不长什么样。

## 前置了解

- **DSH 是什么**：DeepSeek Harness，agent 的宿主运行时。本插件是一条标准的 **Cordis 插件**，经 [cordis.patch.yml](cordis.patch.yml) 的 bundle patch 装载，只 `inject: ['tools']`、零工具注册。
- **宿主版本**：`@deepseek-ai/dsh-tools`：`^0.2.0-rc.1 || ^0.2.1-alpha.2`（与 `peerDependencies` 同口径）。工作区根优先用 `workingDirectory` 服务（dsh ≥0.2.1-alpha.2），更早版本回落 `exec.agent.session.header.cwd`，最后回落 `process.cwd()`。
- **不需要发布到 npm 也能装**：`pnpm build` 出的目录，或 `pnpm pack` 出的 tarball，直接喂给宿主的 `plugin_manager` 即可（见下文「安装」）。

## 定位：行为增强，不是能力增强

agent 本来就会写文件，缺的不是能力，是**习惯**。这个插件不提供任何新工具，只在它动手的那一刻纠正一次：

| | 之前的默认行为 | 本插件在养成的习惯 |
|---|---|---|
| **放哪、叫什么** | 新文件往根目录一丢，或者全塞进 `docs/` 就完事 | 按类型归位：`docs/guides/`、`docs/research/`、`docs/adr/0007-…`、`docs/projects/PRJ-0001/design/` |
| **内容长什么样** | 需求文档缺章节、编号对不上、表格缺列，写完没人管 | 按规范写：结构节、必备表格、编号链、证据分级都可机器判定 |

习惯只能靠**反馈回路**养成，所以全篇设计只围绕两件事：

1. **规范不常驻**。规范住在 `.dsh/*.yaml` 里，**不进 system prompt、不占工具面**。写了 prompt 也不会看；看了也会随文档变长而衰减。它只在**被打回的那一刻**随工具结果出现——附上正确路径、`docs/` 现状、分类菜单、目标模板。
2. **不阻止它写，只让它改对**。打回不是一句报错，而是一张「该怎么建」的说明书。默认策略下，路径不合规时插件甚至直接代写到对的位置，agent 连重试都省了。

## 三条设计原则

| 原则 | 含义 |
|---|---|
| **不重写、也不新增工具** | `write` / `edit` 是宿主的，本插件**一个工具都不注册**；只在 `tools/pre-execute` / `tools/post-execute` 挂监听器做加强 |
| **规则不常驻** | 规范不进 system prompt，也不占工具面；只在「创建被拦下」的那一刻进入对话 |
| **你是唯一权威** | 加载优先级永远是「工作区 `.dsh/` 文件 > 内置默认」：文件在就只看文件（改完即生效，mtime 热重载）；文件不在就回落内置默认**继续判定**（装完第一单就生效），同时把默认落盘成工作区草稿——从落盘那一刻起权威就归工作区 |

第 1 与第 2 条是一体的：工具名 + description + 参数文档是**常驻** system prompt 的，注册工具就等于把规则面挂上去。
所以本插件一个工具都不注册，「问用户」用宿主自带的 `ask_user_question`，「改规则」用原生 `write` 直接改 yaml。

## 两个子系统

各管一件事，互不重叠：

```
.dsh/folder-path-rules/<ext>.yaml   管「放哪、叫什么」     ← 一个文件类型一份
.dsh/file-format-specs/<type>/      管「内容长什么样」     ← 一个文档类型一个文件夹
```

| | 触发时机 | 管的对象 | 不符合时 |
|---|---|---|---|
| **路径子系统** | `tools/pre-execute`（落盘前） | **新建**的 `.md` | 自动纠偏 / 打回附指引单 |
| **内容子系统** | `tools/post-execute`（落盘后） | `write` / `edit` 命中的文档类型 | 打回附不符合清单 + 目标模板 |

## 路径子系统：放哪、叫什么

### 判定链

```
agent 要新建文件
│
├─ ① 该扩展名有规则文件吗？            没有 → 放行（「只拦 md」由此实现）
│
├─ ② 落在工作区根目录吗？              白名单（README/CHANGELOG/CLAUDE/AGENTS… ∪ yaml.root_allow）放行
│                                       非白名单 → 硬拦（永不豁免）
├─ ③ 落在主目录（默认 docs/）之外吗？    首次打回并指路；第二次放行（自由发挥）
│
├─ ④ 主目录下、已落在子目录里
│      ├─ 该目录现实中存在（哪怕 yaml 没登记）→ 放行（按现实惯例）
│      ├─ 是 yaml 分类 → 校验命名 / 集合型实例编号
│      └─ 两者都不是 → 打回；第二次放行
│
└─ ⑤ 主目录下、直接落在主目录（未分类）
       ├─ 匹配现实目录 → 🔧 自动纠偏到该目录
       ├─ 匹配 yaml 分类 → 🔧 自动纠偏到规范路径
       └─ 都不中 → 打回（附：现有结构 + 分类菜单）；第二次放行
```

**优先级：目录现状 > yaml 规则 > 自由发挥。** 老项目接入时顺着已有结构走；新项目由规则立结构；规则没覆盖的场景交给 agent，不卡死。

「打回」不是一句错误，而是一张**指引单**：拦截原因 + 正确路径 + `docs/` 现有结构（含各目录文件数与样例）+ 可用分类菜单 + 下一步怎么做。agent 看懂就地学会，用正确路径重试后放行。

### 回执长什么样

**自动纠偏（默认）**——文件已经在对的位置了：

```
路径不合规，本次 write 未执行。
该文件已按项目规范写入：docs/guides/login-guide.md
  · 你请求的路径：docs/login-guide.md（未分类，已自动归位）
  · 判据来源：项目规范｜分类：guides
  · 不要再用原路径重试；后续同类文件请直接使用 docs/guides/login-guide.md
```

**打回 + 指引单**（`autoCorrect: false`，或规则没覆盖到）：

```
⛔ 文件未创建：notes.md
【拦截原因】根目录不允许新建该类文件
【正确路径】docs/guides/notes.md
  （判据：项目规范）
【请重试】用这个路径再调一次 write，内容原样即可：
  write({ file_path: "docs/guides/notes.md", content: <你刚才的内容> })

【docs/ 现状】
  - docs/guides/  （4 个文件，如 login-guide.md、deploy.md）
  - docs/adr/  （7 个文件）
【可用分类】
  - guides → docs/guides/{slug}.md｜关键词：指南/教程/guide
  - adr → docs/adr/{auto_number:4}-{slug}.md｜关键词：决策/adr/decision
【下一步】
  1) 直接按上面的【正确路径】重试 write（这是最省事的一条路）
  2) 想换别的分类 → 从「可用分类」里挑一个，按其 dest 拼路径重试 write
  3) 确认分类都不合适 → 先用 ask_user_question 问用户，同意后把新分类写进 .dsh/folder-path-rules/md.yaml
```

### 纠偏策略：默认「自动纠偏」

| | 方案 A（默认，`autoCorrect: true`） | 方案 B（`autoCorrect: false`） |
|---|---|---|
| 做法 | 插件按规范路径把内容写下去，打回原调用并回执实际落点 | 打回，指引单给出【正确路径】，由 agent 重试 write |
| 工具调用 | 1 次（原调用被拒，但文件已就位） | 2 次（被拒 + agent 用新路径重试） |
| 文件的写者 | 插件（**经宿主 `fs` 服务**：`fs.resolve` + `fs.writeText`，子目录 recursive 建出、文件策略参与） | 宿主原生 `write` |

为什么**不能**直接把 `file_path` 改掉、让原生 write 写到纠正后的路径：宿主把 `exec.arguments` **深度冻结**，且 `PreToolDecision` 只有 `allow/deny/cancel/ask`、没有「改参数」一档——所以要么插件代写（A），要么让 agent 重新下单（B）。

> 代写优先走宿主的 `fs` 服务（服务缺失才回落 `node:fs`），避免插件绕过宿主的文件策略与审计。
> 代写走不到 `post-execute`（原调用已被拒），所以**代写前会单独先做一次内容校验**，不合规就不落盘。

### 规则文件

一个文件类型一个文件：`.dsh/folder-path-rules/md.yaml` → 管 `*.md`。目录里没有的类型 = 不受约束。完整示例见 [examples/md.yaml](examples/md.yaml)（与内置默认草稿**逐字节一致**，测试守护）。

**冷启动（装完即用）**：工作区没有 md 规则文件时，加载**回落内置默认**继续判定（第一单就按规范纠偏/打回），同时把默认规则写入 `.dsh/folder-path-rules/md.yaml` 并记日志。优先级永远是「工作区文件 > 内置默认」：文件一旦存在（包括垫片自己落下的这份），内置默认立即让位。三个边界：

- 工作区已有任何 `.dsh` 规则文件（哪怕只保留其他类型、删过 md.yaml）→ 绝不复活、绝不覆盖；
- 垫片内容就是 [examples/md.yaml](examples/md.yaml)，头部注释写明了怎么改：增删分类、改 `dest` 模板、调关键词，改完即生效；
- 不想要回落与自动落盘：插件配置 `scaffoldDefault: false`（`cordis.patch.yml` 的 config 里加）——回到「无规则即放行」的旧行为。

```yaml
type: md
root: docs                 # 该类型的主目录
root_allow: [TODO.md]      # 根目录白名单（追加在内置默认之上）

categories:
  guides:
    folder: guides
    keywords: [指南, 教程, guide, tutorial]   # 用于把「文件主题词」归位
    naming: kebab-case                        # kebab-case / camelCase / PascalCase / snake_case / any
    dest: "guides/{slug}.md"

  adr:
    folder: adr
    keywords: [决策, adr, decision]
    dest: "adr/{auto_number:4}-{slug}.md"     # 扫目录取 max+1，补 4 位

  project:
    folder: projects
    kind: collection                           # 集合型：先有实例编号文件夹，再放文件
    keywords: [项目, 需求, 设计, 计划]
    instance:
      param: project_id
      pattern: "^PRJ-\\d{4}$"
      acquire: auto
      scaffold: [requirement/, design/, plan/] # 骨架目录
    variants:
      design:
        keywords: [设计, design]
        dest: "projects/{project_id}/design/{slug}.md"
```

占位符：`{slug}` `{folder}` `{root}` `{auto_number:4}` `{project_id}`。

## 内容格式规范：内容长什么样

一份规范 = 一个文档类型（需求文档 / PRD / 设计文档 / 埋点与指标方案 / 调研报告…）。

```
write / edit 落盘成功
   │
   ├─ 匹配：文件名（basename）× 有序 match 表（关键词包含 / glob，大小写不敏感；priority 大者先，首个命中）
   │        需要按目录限定时加 match_path；匹配不上 → 不管（静默放行）
   │
   └─ 校验：按匹配到的 spec 跑 rules（规则引擎）
            符合   → accept，零返回（agent 无感）
            不符合 → block：一次报全所有违规 + 行号 + 目标结构
                     → agent 改完再 write/edit，直到符合
```

打回文本里除了错误清单，还带一份**目标结构**：spec 配了 `template.md` 就贴模板正文；模板读不到就按
`sectionsRequired` / `frontmatterRequired` / `tableRequired` 规则反推一份骨架（[skeleton.ts](src/content-format/skeleton.ts)）。
配了 `example.md` 还给一个「填写参考」指针——保证 agent 每次都知道「改成什么样子」。

### 目录与示例

```
.dsh/file-format-specs/
  <type>/                     # 目录名 = 类型名
    spec.yaml                 # 规范：match + rules（name 默认 = 目录名）
    template.md               # 骨架（template 默认 = 本文件）
    example.md                # 可选：填好的参考（打回时给指针，不内联）
```

**冷启动（装完即用）**：`.dsh/file-format-specs/` 为空时，校验**回落内置默认**（五套全生效），同时把它们写入工作区并记日志。边界同路径规则：已有任何类型（哪怕只剩一套）→ 绝不复活被删的、绝不覆盖；`scaffoldDefault: false` 一并关闭回落与落盘。内置默认与下表 examples **逐字节一致**（`pnpm sync:specs` 由 examples/ 重新生成，测试守护）。

随包五套示例，一个类型一个文件夹：

| 类型 | 管什么 | 特色判据 |
|---|---|---|
| [requirement](examples/file-format-specs/requirement/spec.yaml) | 需求池（PRD 上游）：R-x 诉求 + 验证与排序 | 优先级只认 MoSCoW 词表；被拒/延期项必须留痕 |
| [prd](examples/file-format-specs/prd/spec.yaml) | PRD：19 节（含发布公告、客户 FAQ、内部 FAQ） | FR-x 清单 ↔ 明细对齐（描述 / 验收标准必填）；**不可为空的节**用 `idDetails` 逐项校验 |
| [design](examples/file-format-specs/design/spec.yaml) | 设计文档：Google 结构 + Amazon 内部 FAQ | 每个 H2 必须带 `serves: FR-x`；接口 IF-x 必给错误码与兼容性 |
| [metrics](examples/file-format-specs/metrics/spec.yaml) | 埋点与指标方案 | 指标 M-x ↔ 埋点 EV-x **双向追溯** |
| [research](examples/file-format-specs/research/spec.yaml) | 调研报告 | 证据分级 A/B/C/D（至少一条 A 或 B）+ 问题 Q-x ↔ 证据 E-x **双向追溯** |

### spec.yaml

```yaml
# .dsh/file-format-specs/prd/spec.yaml
ext: md
priority: 90
match:                 # 文件名匹配：无 * ? = 关键词包含；有 * ? = glob；都大小写不敏感
  - "prd"              # 命中 prd.md / prd-需求.md / 需求-prd.md / PRD.md
  - "产品需求"
# name / template / example 都走默认：取目录名与同目录 template.md / example.md
mode: block            # block 打回 | warn 只提示 | off
diff_mode: delta       # delta 只拦本次新增违规（旧文件历史问题不背锅）| strict
max_attempts: 3
on_exhausted: allow    # 用尽后 allow 放行 | block 继续拦

rules:
  - id: fm
    assert: { fn: frontmatterRequired, args: [{ keys: [title, status] }] }
  - id: status-enum
    assert: { fn: frontmatterEnum, args: [{ key: status, values: [draft, review, approved, superseded] }] }
  - id: sections            # 实际示例是 19 节（这里为篇幅缩写）；只认 H2，节名归一化后精确匹配
    assert:
      fn: sectionsRequired
      args:
        - order: true
          headings: [摘要, 发布公告, 背景与问题, 目标与非目标, 成功指标, 目标用户与场景,
                     用户旅程与流程设计, 原型与交互说明, 功能需求, 非功能需求, 边界与异常路径,
                     约束与依赖, 风险与缓解, 常见问题, 备选方案, 发布与回滚, 时间线, 开放问题, 附录]
  - id: fr-table
    assert: { fn: tableRequired, args: [{ under: 功能需求, header: [编号, 需求, 优先级, 验收判据] }] }
  - id: fr-details
    assert: { fn: idDetails, args: [{ under: 功能需求, fields: [描述, 验收标准], optional: [业务规则] }] }
```

### 判据从哪来

**内置原语**（引擎内置函数，`args[0]` 是参数对象）：`frontmatterRequired` / `frontmatterEnum` / `frontmatterPattern` /
`sectionsRequired` / `sectionsForbidden` / `sectionsServes` / `tableRequired` /
`ids`（编号重复 / 跳号）/ `idDetails`（清单↔明细对齐 + 明细必填小节）/ `forbiddenText` / `requiredText` / `size` / `templateSections`，
外加取值助手 `hasSection` / `sectionText` / `collectIds` / `countIds` / `frontmatter` / `length` / `count` / `matches` / `exists`。
解析会**跳过代码围栏**，结构判定不误伤文中贴的代码。

**动态函数**（内置不够用时写 JS，改完即生效）：

```yaml
functions:
  hasOwner:
    expr: "!!(frontmatter.owner || frontmatter.owner_team)"

  everySectionServes:
    script: |
      return doc.headings
        .filter(h => h.level === 2 && !/serves\s*[:：]/i.test(h.text))
        .map(h => ({ message: '章节「' + h.text + '」缺 serves 标注', line: h.line }))

rules:
  - id: has-owner
    assert: { fn: hasOwner, message: "文档必须有 owner 或 owner_team" }
  - id: every-section-serves
    assert: { fn: everySectionServes }
```

脚本上下文只注入白名单：`doc`（解析后的结构）、`text`、`fileName`、`relPath`、`specName`、`api`（`hasSection` / `section` /
`collectIds` / `frontmatter` / `violation`）。`script` 返回 `undefined` / `null` / `true` / 空数组视为通过；
`string`、或 `{message, line, key, severity}`、或它们的数组视为违规。`expr` 按真假判定。
单次执行 1 秒超时；函数抛错只记一条「函数执行失败」，绝不拖垮写文件。

> 两个坑，写在前面：① **脚本看不到同一个 spec 里的其他函数**（沙箱只给白名单），小工具要在每个脚本里自带；
> ② **计数类判据必须数表格的行，不能数全文里编号的出现次数**（一条证据被引用 6 次不等于 6 条证据）。

### 规则引擎

校验内部就是一个规则引擎：文档解析成**事实**，rule 是**条件树**，内置原语和动态代码都只是引擎里的**函数**——spec 只声明 `rules` / `derive` / `functions`。三个能力：

- **条件树**：`all` / `any` / `not` / `path`（比较算子）/ `each` / `exists` / `count` / `fn`
- **前向链**：`derive` 先派生事实，规则再在更丰富的事实上判定
- **自定义函数**：`functions` 里用 `expr` 或 `script` 注册，规则用 `fn` 调用

```yaml
derive:
  - fact: requirementCount
    fn: countIds
    args: [["R"]]

rules:
  - id: at-least-one-requirement
    assert: { path: "requirementCount", op: "gte", value: 1, message: "至少要有一条编号" }
```

执行序：初始事实 → derive → rules（priority 降序）→ 聚合违规（带行号）。

内容打回长这样：

```
⛔ 内容未通过格式规范：docs/prd/login.md
    匹配到的规范：prd（模板 template.md）
【符合情况】3 项不符合（第 1 次，最多 3 次）

【不符合清单】
  1. [sections] 缺章节「发布公告」
  2. [fr-table] 表缺列「验收判据」（第 42 行）
  3. [fr-details] 清单有 FR-2，但缺对应明细标题

【目标模板（把文档改成这个结构）】
<模板全文>

【填写参考】.dsh/file-format-specs/prd/example.md（一份填好的同类文档，可用 read 打开）
【怎么改】把文档改成上面的目标结构，并逐条修正不符合项；用 write 或 edit 修同一文件
```

## 配置

装载行在 [cordis.patch.yml](cordis.patch.yml)（`id: dsh-file-enhance`）。**规则不在这里配**——规则住工作区 `.dsh/`。

| 配置 | 默认 | 含义 |
|---|---|---|
| `autoCorrect` | `true` | 路径未分类时由插件代写到规范路径（落点已存在则不覆盖）；设 `false` 改为打回让 agent 重试 |
| `contentValidate` | `true` | 是否挂内容格式校验（`post-execute`） |
| `scaffoldDefault` | `true` | 冷启动垫片：工作区没有规则时回落内置默认继续判定，并把默认规则落盘到 `.dsh/`；`false` = 无规则即放行（旧行为） |

安装（不需要发布到 npm）：

```bash
git clone git@github.com:kakaCat/dsh-file-enhance.git
cd dsh-file-enhance
pnpm install && pnpm build       # → dist/index.mjs
pnpm pack                        # 可选：产出 dsh-file-enhance-<version>.tgz
```

然后在 DSH 会话里用 `plugin_manager` → `install_bundle`，target 指向上面的目录或 tarball。
插件装载后的行为由「配置表 + 工作区 `.dsh/` 规则」决定，不依赖任何全局安装。

冷启动（两步，都是复制）：

```bash
cp examples/md.yaml .dsh/folder-path-rules/md.yaml          # 路径规则（不想要就不建，等于只拦内容）
cp -r examples/file-format-specs .dsh/file-format-specs     # 内容规范（按需删掉不要的类型）
```

## 工具面：零

**本插件不注册任何工具**，agent 侧看不到任何 `file_*`，能力全部长在原生工具的行为上：

| 你想做的事 | 怎么做 |
|---|---|
| 建文件 | 直接 `write`。合规就静默放行；未分类会被**自动纠偏**并回执实际落点 |
| 知道该放哪 | 不用提前问——打回指引单里已经给了正确路径、`docs/` 现状和分类菜单 |
| 新增一个分类 | 先调宿主自带的 **`ask_user_question`** 征得用户同意，再用**原生 `write`** 把分类写进 `.dsh/folder-path-rules/<ext>.yaml`，改完即生效 |
| 改文档结构 | `write` / `edit` 修同一文件；不合规会打回一次报全，并附目标模板 |
| 初始化 | 复制 [examples/md.yaml](examples/md.yaml) 与 `examples/file-format-specs/`（见上文冷启动） |

为什么一个工具都不注册：工具名 + description + 参数文档是**常驻** system prompt 的，注册工具就等于把规则面挂上去，
与「规则不常驻」直接冲突。而「建文件前先问落点」这类工具买到的只是省一次打回往返，代价是常驻上下文。

## 本插件不做什么

边界是有意画的，不是缺功能：

- **不重写、不新增工具**。加强只发生在监听器里
- **不管存量文件**。判定链只在「目标文件不存在」时跑。接入之前就已经躺在那里的乱文件，本插件结构上看不见——那是用户自己的事
- **不校验规则文件本身**。`.dsh/` 下的写入不受拦截；规则 yaml 写坏了，加载器只打一条 warn 并跳过该类型，表现是「规则静默不生效」，需要你自己复查
- **不管非 `.md`**。目录里没有 `<ext>.yaml` 就没有约束
- **不管改旧文件**。`write` / `edit` 命中已存在的目标时，路径判定直接放行（内容校验仍生效）

## 已知边界

- **只拦 `write` 新建的 `.md`**：非 md 不管；`bash` 里 `echo > x.md` 这类写法绕得过去（靠 prompt 纪律兜底）
- **不能改工具入参**：`exec.arguments` 深度冻结、`PreToolDecision` 没有「改参数」一档，故默认由插件代写（见上文纠偏策略）
- **同一目标连拦一次即放行**（自由发挥）：根目录禁令不适用此豁免；拦截记忆保留 10 分钟
- **内容校验发生在落盘之后**：不合规时文件已写入，`block` 把工具结果变成错误让 agent 修；终止预算见 `max_attempts` / `on_exhausted`
- **`edit` 按整篇校验**：`diff_mode: delta` 只把「改完新增的违规」算到本次头上，旧文件的历史问题不背锅
- **工作区根按 agent 解析**，不是插件进程 cwd：`workingDirectory` 服务（dsh ≥0.2.1-alpha.2）→ `exec.agent.session.header.cwd`（0.2.0-rc.x）→ `process.cwd()` 回落
- **改插件代码后需重启宿主**：ESM 模块缓存，HMR 不监视 `node_modules` 里的 bundle

## 开发

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest：判定链 + 拦截器三态 + 格式校验 + 示例/文档守护（8 文件 / 130 用例）
pnpm build       # tsdown → dist/
```

```
src/index.ts               插件入口（只 inject tools，挂两个监听器；不注册任何工具）

src/folder-path/           路径 / 落点子系统（读 .dsh/folder-path-rules/）
  types.ts                 领域类型
  paths.ts                 路径与命名纯函数
  rules.ts                 <ext>.yaml 加载 + mtime 热重载
  scan.ts                  现实结构扫描（docs/ 现状）
  decide.ts                判定链（核心纯函数）
  guidance.ts              指引单渲染（路径侧唯一的规范注入内容）
  intercept.ts             tools/pre-execute 监听（判定 + 代写 + 代写前内容校验）

src/content-format/        内容格式子系统（读 .dsh/file-format-specs/）
  types.ts                 内容格式领域类型
  spec.ts                  *.yaml 加载 + 模板读取
  match.ts                 文件匹配：相对路径 × 有序 match 表 → spec
  parse.ts                 文档结构解析（跳过代码围栏）
  primitives.ts            内置检查原语（sectionsRequired / tableRequired / idDetails / …）
  validate.ts              校验编排 + delta 归责
  report.ts                内容指引单渲染（含目标模板 / 骨架 / 填写参考）
  skeleton.ts              无模板时从规则推目标结构骨架
  attempts.ts              尝试计数与终止
  script.ts                表达式 / 脚本沙箱（vm + 白名单 + 1s 超时）
  post-check.ts            tools/post-execute 监听（匹配 + 内容校验 + block）
  rules/                   规则引擎（engine / condition / builtin / functions / operators / path）

examples/md.yaml                     随包示例路径规则（唯一一份）
examples/file-format-specs/<type>/   随包示例内容规范（spec.yaml + template.md + example.md）
docs/                               设计与测试文档（模板设计、格式校验设计、测试方案）
test/                               vitest：decide / intercept / rules / format / docs
```

## 相关文档

- [模板文档设计](docs/template-authoring.md)——模板与规则的结构契约、占位符语法、五套示例的设计来源
- [格式校验设计](docs/content-validation-design.md)——匹配、解析、原语、规则引擎的实现细节
- [测试方案](docs/test-plan.md)——覆盖范围与实测记录

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
