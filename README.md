# dsh-file-guide

DSH 插件：**让 agent 按项目自己的规范创建文件**——不再把文件一股脑堆在根目录。

解决的三个现场问题：

1. agent 把新文件建在根目录，时间久了根目录烂掉、也看不出文件是干什么的
2. 告诉它「放到 docs 里」之后，它就只知道 docs，不会按类型再分文件夹
3. 特殊场景（一个功能 = 一个项目）不会归档到编号文件夹里

## 三条设计原则（讨论中冻结的结论）

| 原则 | 含义 |
|---|---|
| **规则不常驻** | 规范不进 system prompt。只在「创建被拦下」的那一刻，随工具结果进入对话 |
| **你是唯一权威** | 插件不内置任何生效中的规则；规则住 `.dsh/file-rules/<ext>.yaml`，由你设计、改完即生效 |
| **不重写写文件工具** | `write` 还是宿主的 `write`；插件只在 `tools/pre-execute` 判定：放行 / 自动纠偏 / 打回 |

## 判定链

```
agent 要新建文件
│
├─ ① 该扩展名有规则文件吗？            没有 → 放行（「只拦截 md」由此实现）
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
       ├─ 匹配 yaml 分类 → 🔧 自动纠偏到规范路径（adr 会分配编号）
       └─ 都不中 → 打回（附：现有结构 + 分类菜单）；第二次放行
```

**优先级：目录现状 > yaml 规则 > 自由发挥。** 老项目接入时顺着已有结构走；新项目由规则立结构；规则没覆盖的场景交给 agent，不卡死。

「打回」不是一句错误，而是一张**指引单**：正确路径、`docs/` 现有结构（含各目录文件数与样例）、可用分类菜单、下一步重试方式。agent 看懂就地学会，用正确路径重试后放行。

## 纠偏策略：默认「自动纠偏」（方案 A）

未分类文件被判定后，路径已经算好了，接下来有两种接法：

| | 方案 A（默认） | 方案 B（`config.autoCorrect: false`） |
|---|---|---|
| 做法 | 插件按规范路径把内容写下去，打回原调用并回执实际落点 | 打回，指引单给出【正确路径】，由 agent 重试 write |
| 工具调用 | 1 次（原调用被拒，但文件已就位） | 2 次（被拒 + agent 用新路径重试） |
| 文件的写者 | 插件（**经宿主 `fs` 服务**：`fs.resolve` + `fs.writeText`，子目录 recursive 建出、文件策略参与） | 宿主原生 `write` |

选 A 的原因：一次往返就把文件放到对的地方，agent 不必重试。
为什么**不能**直接把 `file_path` 改掉、让原生 write 写到纠正后的路径：宿主把 `exec.arguments`
**深度冻结**（`tools/src/index.ts:1445`），且 `PreToolDecision` 只有 `allow/deny/cancel/ask`、
没有「改参数」一档——所以要么插件代写（A），要么让 agent 重新下单（B）。

> 代写优先走宿主的 `fs` 服务（服务缺失才回落 `node:fs`），避免插件绕过宿主的文件策略与审计。

## 安装

```bash
# 在 DSH 里（plugin_manager）：
#   install_bundle  <本包路径或打包产物>
# 本地开发：
pnpm install && pnpm build     # → dist/index.mjs
```

装载行在 `cordis.patch.yml`（`id: dsh-file-guide`）。规则不在这里配。

## 规则文件

一个文件类型一个文件：`.dsh/file-rules/md.yaml` → 管 `*.md`。目录里没有的类型 = 不受约束。

```yaml
type: md
root: docs                 # 该类型的主目录
root_allow: [TODO.md]      # 根目录白名单（追加在内置默认之上）

categories:
  guides:
    folder: guides
    keywords: [指南, 教程, guide, tutorial]
    dest: "guides/{slug}.md"

  adr:
    folder: adr
    keywords: [决策, adr, decision]
    dest: "adr/{auto_number:4}-{slug}.md"     # 扫目录取 max+1，补 4 位

  project:
    folder: projects
    kind: collection                           # 集合型：先有实例编号文件夹
    keywords: [项目, 需求, 设计, 计划]
    instance:
      param: project_id
      pattern: "^PRJ-\\d{4}$"
      acquire: auto                            # 编号由插件分配
      scaffold: [requirement/, design/, plan/] # 建骨架目录
    variants:
      design:
        keywords: [设计, design]
        dest: "projects/{project_id}/design/{slug}.md"
```

占位符：`{slug}` `{folder}` `{root}` `{auto_number:4}` `{project_id}`。
命名风格：`naming: kebab-case | camelCase | PascalCase | snake_case | any`。

冷启动：调 `file_rules_init` 落一份示例（`examples/md.yaml`），再按项目习惯增删。

## 工具

| 工具 | 用途 |
|---|---|
| `file_resolve` | 建文件前问「该放哪、叫什么、套什么模板」；集合型分类可自动分配编号并建骨架目录 |
| `file_propose` | 现有分类都不合适时，向**用户**提议新增分类（弹框批准后写入 yaml） |
| `file_check` | 巡检：某文件是否合规；或扫主目录列出野文件 |
| `file_rules_init` | 写入示例规则（已存在则不动） |

## 已知边界

- **只拦 `write` 新建的 `.md`**：改旧文件不管；非 md 不管；`bash` 里 `echo > x.md` 这类写法绕得过去（第一版不拦，靠 prompt 纪律 + `file_check` 巡检兜底）
- **不能改工具入参**：宿主 `pre-execute` 只有 allow/deny/cancel/ask，参数已深度冻结，故「让原生 write 写到纠正后的路径」不可能；默认改为插件经宿主 `fs` 服务代写（`autoCorrect: true`），想要 agent 自己重试就设 `autoCorrect: false`
- **同一目标连拦一次即放行**（自由发挥）：根目录禁令不适用此豁免

## 开发

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest：判定链分支 + 拦截器三态 + 示例规则守护
pnpm build       # tsdown → dist/
```

目录：

```
index.ts            插件入口（inject tools / userQuestions，接线拦截器与工具）
src/types.ts        领域类型
src/paths.ts        路径与命名纯函数
src/rules.ts        .dsh/file-rules/<ext>.yaml 加载 + mtime 热重载 + 回写
src/scan.ts         现实结构扫描（docs/ 现状）
src/decide.ts       判定链（核心纯函数）
src/guidance.ts     指引单渲染（唯一的规范注入内容）
src/intercept.ts    tools/pre-execute 监听
src/tools.ts        四个工具 + 内置示例规则
examples/md.yaml    随包示例规则
```
