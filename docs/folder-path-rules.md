# 路径规则：放哪、叫什么

> 这份文档是 `README` 的下沉版：判定链的每个分支、规则文件的每个字段、纠偏策略与常见改法。
> 只想上手看 [README](../README.md#路径规则放哪叫什么)。

规则住在工作区：`.dsh/folder-path-rules/<ext>.yaml`，**一个文件类型一个文件**。目录里没有的类型 = 不受约束。

## 判定链

```
agent 要新建文件
│
├─ ① 该扩展名有规则文件吗？            没有 → 放行（「只拦 md」由此实现）
│
├─ ② 落在工作区根目录吗？              白名单（README/CHANGELOG/CLAUDE/AGENTS… ∪ yaml.root_allow）放行
│                                       非白名单 → 硬拦（永不豁免，第二次也拦）
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
       │    └─ 渲染结果就是当前位置（dest: "{slug}.md"）→ 放行，不移动
       └─ 都不中 → 打回（附：现有结构 + 分类菜单）；第二次放行
```

**优先级：目录现状 > yaml 规则 > 自由发挥。** 老项目接入时顺着已有结构走；新项目由规则立结构；规则没覆盖的场景交给 agent，不卡死。

「自由发挥」= 同一目标第二次尝试即放行（首次拦截只做教导）。**根目录禁令不适用该豁免。**

## 规则文件

```yaml
type: md
root: docs                 # 该类型的主目录
root_allow: [TODO.md]      # 根目录白名单（追加在内置默认之上）

categories:
  # 项目级文档：设计稿 / 测试方案 / 规则说明这类，本来就该直接放 docs/ 根。
  # dest 写 "{slug}.md" → 渲染结果就是当前位置，判定直接放行（不移动、不打扰）。
  # 没有这一条，docs/ 根下的新文档会被判「未分类」。
  meta:
    folder: meta
    keywords: [设计, 方案, 规范, 规则, 模板, 测试, 计划, 说明, design, spec, rules, template, test, plan]
    dest: "{slug}.md"

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
    # 变体不写 keywords：变体只在文件已落在 projects/PRJ-xxxx/<变体>/ 下时按目录名匹配。
    # 给了关键词，它就会去抢 docs 根下的裸文件，而那条路径没有实例编号，只能报 need-allocate。
    variants:
      design:
        dest: "projects/{project_id}/design/{slug}.md"
```

占位符：`{slug}` `{folder}` `{root}` `{auto_number:4}` `{project_id}`，
外加时间三兄弟 `{date}` `{time}` `{datetime}`（可带格式，如 `{date:YYYYMMDD}`）。

**时间前缀**（设计见 [date-prefix-design.md](date-prefix-design.md)）：

```yaml
  daily:
    folder: daily
    keywords: [纪要, 日报]
    dest: "daily/{date}-{slug}.md"          # → docs/daily/2025-10-15-晨会纪要.md
  minutes:
    folder: minutes
    keywords: [会议]
    dest: "minutes/{date:YYYYMMDD}/{slug}.md"   # 日期当目录段也行
```

- 文件名缺日期前缀 → 自动补齐（纠偏）；已带前缀 → 剥掉再按 `naming` 校验，不会重复叠加；
- 时间只在目录段时（`minutes/{date}/{slug}.md`）：已落在当天目录 → 放行；直接落在分类目录 → 纠偏进日期子目录；
- 同一天同一主题重复创建 → **打回而不是覆盖**（回执会说清「同一天同一主题的第二次创建」）；
- 时间取值是**判定那一刻**的本机时钟，不读 mtime、不联网。

**完整示例**：[examples/md.yaml](../examples/md.yaml)——与内置默认草稿逐字节一致（测试守护）。

## 回执长什么样

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

## 纠偏策略

| | 方案 A（默认，`autoCorrect: true`） | 方案 B（`autoCorrect: false`） |
|---|---|---|
| 做法 | 插件按规范路径把内容写下去，打回原调用并回执实际落点 | 打回，指引单给出【正确路径】，由 agent 重试 write |
| 工具调用 | 1 次（原调用被拒，但文件已就位） | 2 次（被拒 + agent 用新路径重试） |
| 文件的写者 | 插件（经宿主 `fs` 服务：`fs.resolve` + `fs.writeText`） | 宿主原生 `write` |

为什么**不能**直接改 `file_path` 让原生 write 写到纠正后的路径：宿主把 `exec.arguments` **深度冻结**，
且 `PreToolDecision` 只有 `allow/deny/cancel/ask`、没有「改参数」一档。

代写前会**单独再做一次内容校验**（代写走不到 `post-execute`），不合规就不落盘；落点已存在一律不覆盖。

## 冷启动

工作区没有某类型规则文件时，**回落内置默认**继续判定（装完第一单就生效），同时把默认规则写入
`.dsh/folder-path-rules/<ext>.yaml` 供修改。三个边界：

- 工作区已有任何 `.dsh` 规则文件（哪怕只保留其他类型）→ 绝不复活、绝不覆盖；
- 垫片内容就是 [examples/md.yaml](../examples/md.yaml)，头部注释写明怎么改；
- 不想要回落与自动落盘：配置 `scaffoldDefault: false`。

## 常见改法

| 想做的事 | 改哪里 |
|---|---|
| 新增一个分类 | `categories` 里加一项（`folder` + `keywords` + `dest`），agent 用原生 `write` 改即生效 |
| 允许根目录多一个固定文件 | `root_allow` 追加；根目录禁令没有第二次放行，必须登记 |
| 改文件名风格 | 该分类的 `naming`（或分类内 `variants[].naming`） |
| 编号类文件（ADR / RFC） | `dest` 用 `{auto_number:4}`，扫同目录取 max+1 |
| 项目制文档 | `kind: collection` + `instance`，先建 `PRJ-xxxx` 实例目录再放文件 |
| 项目级文档就放 docs/ 根 | `meta` 分类：`dest: "{slug}.md"`，渲染即当前位置 → 放行 |
| 完全关掉路径判定 | 删掉 `.dsh/folder-path-rules/<ext>.yaml`（该类型即不受约束） |

规则改完**即时生效**（按 mtime 热重载），不需要重启宿主。
