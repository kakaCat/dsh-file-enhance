# dsh-file-enhance

[![CI](https://github.com/kakaCat/dsh-file-enhance/actions/workflows/ci.yml/badge.svg)](https://github.com/kakaCat/dsh-file-enhance/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kakaCat/dsh-file-enhance)](https://github.com/kakaCat/dsh-file-enhance/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.0--rc.1-blue)](package.json)
[![Node ≥ 20](https://img.shields.io/badge/node-%3E%3D%2020-339933)](package.json)
[![GitHub repo](https://img.shields.io/badge/github-kakaCat%2Fdsh--file--enhance-blue)](https://github.com/kakaCat/dsh-file-enhance)

DSH 插件：**让 agent 按项目自己的规范创建文件**——不该放哪就不放哪，不该长什么样就不长什么样。

版本与变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 前置了解

- **DSH 是什么**：DeepSeek Harness，agent 的宿主运行时。本插件是一条标准的 **Cordis 插件**，经 [cordis.patch.yml](cordis.patch.yml) 的 bundle patch 装载，只 `inject: ['tools']`、零工具注册。
- **宿主版本**：`engines.dsh = >=0.2.0-rc.1 <0.3.0`——宿主在安装与启动时校验，不满足直接拒绝装载（不靠运行时嗅探）。`peerDependencies` 另声明 `@deepseek-ai/dsh-tools` 的兼容区间。工作区根优先用 `workingDirectory` 服务（dsh ≥0.2.1-alpha.2），更早版本回落 `exec.agent.session.header.cwd`，最后回落 `process.cwd()`。
- **不需要发布到 npm 也能装**：`pnpm build` 出的目录，或 `pnpm pack` 出的 tarball，直接喂给宿主的 `plugin_manager` 即可（见下文「[安装与卸载](#安装与卸载)」）。

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

## 安装与卸载

**前置**：Node ≥ 20（构建需 ≥ 22.18）；DSH 满足 `engines.dsh`（见[兼容性](#兼容性)）。

**第一步，出产物**——`dist/` 不入库，跳过这步会装出一个 import 失败的插件：

```bash
git clone https://github.com/kakaCat/dsh-file-enhance.git
cd dsh-file-enhance
pnpm install && pnpm build       # → dist/index.mjs + dist/index.d.mts
pnpm check:dist                  # 可选：冒烟检查入口 / 插件契约 / bundle patch / 清单本地化
pnpm pack                        # 可选：产出 dsh-file-enhance-<version>.tgz（prepack 会自动 build）
```

**第二步，装进 profile**（二选一）：

- 会话里用 `plugin_manager` → `install_bundle`，target 指向上面的**仓库目录**或 tarball；
- 或命令行 `dsh plugin --profile <profile> add <仓库绝对路径>`。

> 两条路都**不会**替你构建：`install_bundle` 与 `dsh plugin add` 对本地目录走 pnpm 的 link，`prepack` 不触发。
> 所以第一步不能省。插件装载后的行为由「配置表 + 工作区 `.dsh/` 规则」决定，不依赖任何全局安装。

装好后重启 Host（Host 半只在启动时加载）。装成功的判据：插件清单里出现 `dsh-file-enhance`——
展示名与描述来自 [locale/zh.json](locale/zh.json)，中文界面显示「文件规范增强」。

**卸载**：`dsh plugin --profile <profile> remove dsh-file-enhance`，或 `plugin_manager` → `remove_bundle`。
卸载**不删**工作区里的 `.dsh/`——那是你的规则资产，不是插件的；留着不会影响其它插件。

**初始化工作区规则**（可选；不建也不会坏，冷启动垫片会自动落一份可改的默认）：

```bash
cp examples/md.yaml .dsh/folder-path-rules/md.yaml          # 路径规则（不想要就不建，等于只拦内容）
cp -r examples/file-format-specs .dsh/file-format-specs     # 内容规范（按需删掉不要的类型）
```

## 默认规则的杀伤面（实测）

冷启动会往工作区落一份默认规则，落之前值得先回答一个问题：**它会不会一装就满屏打回？**
拿 4970 份真实文档跑了一遍判定链（用随包默认，不读那些仓库自己的 `.dsh/`）：

| 仓库 | 文档数 | 放行 | 纠偏 | 打回 |
|---|---|---|---|---|
| dsh-pmboard | 4453 | 100% | 0% | 0% |
| deepseek-harness | 481 | 91% | 1% | 9% |
| dsh-dataforge | 26 | 100% | 0% | 0% |
| dsh-taskmaster | 10 | 90% | 0% | 10% |
| **合计** | **4970** | **99%** | **0%** | **1%** |

原因在判定链的第一原则：**目录现状优先**。文件已经躺在真实存在的目录里时规则不插手，
它只在「新建」且「落点没有归属」的时候说话。

新建一份典型文档（模拟一个带 `guides/` `adr/` `research/` 的项目）：

| 文件名 | 结果 |
|---|---|
| `prd-登录优化.md` / `产品需求-订单.md` | → `docs/prd/` |
| `指南-部署.md` / `guide-deploy.md` | → `docs/guides/` |
| `adr-0007-选型.md` | → `docs/adr/` |
| `调研-竞品分析.md` / `research-选型.md` | → `docs/research/` |
| `api-支付接口.md` | → `docs/api/` |
| `notes.md` / `meeting-2026-11-01.md` | 打回一次（附分类菜单；第二次放行） |
| `设计-缓存方案.md` | 打回 `need-allocate`：`设计` 是集合型分类的关键词，要求先有 `PRJ-xxxx` 实例目录 |

最后一行是**取舍而不是缺陷**：默认认为设计文档按项目归属（`docs/projects/PRJ-0001/design/…`）。
如果你的习惯是把设计文档散放在 `docs/design/`，把 `project` 的 `keywords` 里的 `设计` 拿掉即可。

复现（先 `pnpm build`）：

```bash
node scripts/calibrate-defaults.mjs ../dsh-pmboard ../deepseek-harness   # 已存在文档
node scripts/calibrate-defaults.mjs --new ../dsh-pmboard                 # 新建典型文档
```

数字会随仓库内容漂移——脚本用于校准，不进测试断言。

## 配置

装载行在 [cordis.patch.yml](cordis.patch.yml)（`id: dsh-file-enhance`）。**规则不在这里配**——规则住工作区 `.dsh/`。

| 配置 | 默认 | 含义 |
|---|---|---|
| `autoCorrect` | `true` | 路径未分类时由插件代写到规范路径（落点已存在则不覆盖）；设 `false` 改为打回让 agent 重试 |
| `contentValidate` | `true` | 是否挂内容格式校验（`post-execute`） |
| `scaffoldDefault` | `true` | 冷启动垫片：工作区没有规则时回落内置默认继续判定，并把默认规则落盘到 `.dsh/`；`false` = 无规则即放行（旧行为） |

## Host 服务：fileEnhance

插件装载时通过 `ctx.provide('fileEnhance', …)` 暴露一个服务，供上层插件在**动手之前**按 profile 预置规范，
而不是只能等写文件被拦下来才触发冷启动垫片。三个方法都按调用时传入的 `root` 解析工作区：

| 方法 | 作用 | 写盘纪律 |
|---|---|---|
| `ensure(root)` | 预置默认规范（路径规则 + 五套文档规范），幂等 | 只写缺失文件 |
| `status(root)` | 读当前规范清单：**生效的类型** + 坏掉的（`invalid`）与缺规范文件的（`missing`）连同原因 | 不写盘 |
| `provision(root, profile)` | 按 `{ rules, formats }` 落指定规范 | 只写缺失文件；**先整体校验**，任一非法就抛 `FileEnhanceError`（`FILE_ENHANCE_INVALID_INPUT`），一个字节都不写 |

```ts
const service = ctx.fileEnhance                 // cordis 服务面
service.ensure('/path/to/workspace')            // → { rules: { dir, types, created }, formats: { … } }
service.status('/path/to/workspace')
// → {
//     rules:   { dir, types: ['md'], invalid: [], missing: [] },
//     formats: { dir, types: ['design', 'prd'], invalid: [{ name, reason }], missing: [{ name, reason }] },
//   }
// invalid / missing 就是「规则写了却不生效」的答案：YAML 写坏、缺 match、目录里没 spec.yaml 都在这
service.provision('/path/to/workspace', {
  rules: [{ ext: 'md', yaml: '<md.yaml 全文>' }],
  formats: [{ name: 'prd', spec: '<spec.yaml 全文>', template: '<template.md 正文>' }],
})                                              // → { created: ['rule:md', 'format:prd'], skipped: [] }
```

判定与校验语义全部复用同一套实现（`RulesStore` / `FormatStore`），服务层只做「预置 / 读取 / 写入」三件事，
不复制任何 `decide` / `validate` 逻辑；因此服务写进去的规范，与用户手写的是同一份东西。

## 工具面：零

**本插件不注册任何工具**，agent 侧看不到任何 `file_*`，能力全部长在原生工具的行为上：

| 你想做的事 | 怎么做 |
|---|---|
| 建文件 | 直接 `write`。合规就静默放行；未分类会被**自动纠偏**并回执实际落点 |
| 知道该放哪 | 不用提前问——打回指引单里已经给了正确路径、`docs/` 现状和分类菜单 |
| 新增一个分类 | 先调宿主自带的 **`ask_user_question`** 征得用户同意，再用**原生 `write`** 把分类写进 `.dsh/folder-path-rules/<ext>.yaml`，改完即生效 |
| 改文档结构 | `write` / `edit` 修同一文件；不合规会打回一次报全，并附目标模板 |
| 初始化 | 复制 [examples/md.yaml](examples/md.yaml) 与 `examples/file-format-specs/`（见「[安装与卸载](#安装与卸载)」） |

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
- **路径规则先于内容规范命中**：路径判定在 `pre-execute`（落盘前），内容校验在 `post-execute`（落盘后）——
  被路径拦下的文件根本走不到内容校验。所以「同一个词被两条规则抢」是会静默失效的：
  随包规则为此把 PRD 单列一类（`docs/prd/`），并把 `prd` / `产品需求` 从 `project` 的关键词里拿掉了。
  自己加分类时注意别让两条分类共用同一个关键词

## 兼容性

| 项 | 要求 |
|---|---|
| DSH | `>=0.2.0-rc.1 <0.3.0`（`engines.dsh`；不满足时**安装与启动都拒绝**，不做运行时嗅探） |
| Node.js | ≥ 20（运行时）；≥ 22.18（构建、`pnpm pack`、CI） |
| 宿主服务 | `tools`（必需，缺了整条装载路径不生效）；`fs`（可选，缺失时代写回落 `node:fs`）；`workingDirectory`（可选，缺失时回落 `session.header.cwd` → `process.cwd()`） |
| 平台 | 与宿主一致（CLI / Desktop / Web 均可——本插件没有客户端半，不注册路由、不画界面） |
| 工作区 | 任意；`.dsh/` 不存在时由冷启动垫片创建 |
| 工具面 | `write` / `edit`（宿主原生）。只拦 `write` 的**新建**，`edit` 只走内容校验 |

## 数据与隐私

- **只读**工作区里的规则与规范：`.dsh/folder-path-rules/*.yaml`、`.dsh/file-format-specs/**`，以及它们指向的 `template.md` / `example.md`；不遍历工作区其它文件。
- **写盘只有两处**：冷启动垫片落默认规则（逐文件 `wx`，目标存在即跳过），自动纠偏代写新文件（落点已存在则**不覆盖**；有宿主 `fs` 服务时经它写，策略与审计仍归宿主）。
- **不联网、不采集、不上报**；全部判定在本地进程内完成，无 LLM 调用、无遥测。
- **用户脚本**（`spec.yaml` 的 `functions.expr` / `functions.script`）在 `node:vm` 的新上下文里执行，只注入 `doc` / `text` / `fileName` / `relPath` / `specName` / `api` 与少量纯函数全局，单次 1 秒超时。
  **`node:vm` 不是安全边界**——本插件的信任模型是「规则文件 = 项目代码」。只把来自可信仓库的 `spec.yaml` 放进工作区；别把第三方 spec 当数据加载。
- **进对话的内容**：打回文本包含工作区相对路径、`docs/` 目录现状（目录名、文件数、样例文件名）与模板正文，都是项目自己的内容。代写失败时会把系统错误原文（可能含绝对路径）带回对话；不希望这样就把 `autoCorrect` 设为 `false`。

## 开发

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest：判定链 + 拦截器三态 + 格式校验 + 示例/文档守护（10 文件 / 178 用例）
pnpm build       # tsdown → dist/
pnpm check:dist  # build 之后跑：入口文件、插件契约、bundle patch、清单本地化
```

> **Node 版本**：`pnpm build` 需要 **Node ≥22.18**（tsdown 的引擎要求 `^22.18.0 || >=24.11.0`；Node 20 会在构建阶段报错）。
> 产物 `dist/` 的目标是 Node 20（`tsdown target: node20`），所以**运行时**仍然支持 Node ≥20，见 `engines`。
> `pnpm pack` / `npm publish` 前会自动跑 `build`（`prepack`），dist 不会漏。

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

src/host/service.ts        Host 服务 fileEnhance（ensure / status / provision，写盘纪律在本层）

examples/md.yaml                     随包示例路径规则（唯一一份）
examples/file-format-specs/<type>/   随包示例内容规范（spec.yaml + template.md + example.md）
docs/                               设计与测试文档（模板设计、格式校验设计、测试方案）
test/                               vitest：decide / intercept / rules / format / docs / service / perf
scripts/sync-builtin-specs.mjs      examples/ → src/content-format/builtin-specs.ts（构建前同步）
scripts/smoke-dist.mjs              dist 装载冒烟：入口 / 插件契约 / bundle patch / 清单本地化
scripts/calibrate-defaults.mjs      拿真实仓库校准默认规则的杀伤面（不进测试断言）
locale/                             插件清单本地化文案（zh / en）
```

## 相关文档

- [模板文档设计](docs/template-authoring.md)——模板与规则的结构契约、占位符语法、五套示例的设计来源
- [格式校验设计](docs/content-validation-design.md)——匹配、解析、原语、规则引擎的实现细节
- [测试方案](docs/test-plan.md)——覆盖范围与实测记录
- [更新日志](CHANGELOG.md)——版本与变更

## 贡献

欢迎 issue 与 PR。提交前跑一遍：

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm check:dist
```

CI 在 Node 22 上跑同样四条（typecheck / test / build / dist 冒烟）。改 `examples/` 下的规范后记得
`pnpm sync:specs` 重新生成内置默认，否则 `test/scaffold-specs.test.ts` 会红——这条守护是有意的，
防止「随包示例」和「插件内置默认」悄悄漂移。

改动请一并更新 [CHANGELOG.md](CHANGELOG.md) 的未发布段落。

## License

[MIT](LICENSE) © 2026 kakaCat

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
