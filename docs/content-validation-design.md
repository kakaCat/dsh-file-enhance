# dsh-file-enhance 设计：路径规范 + 文件匹配 + 格式规范

> **2026-10-15 变更**：插件工具面归零（`file_resolve` / `file_propose` / `file_check` / `file_rules_init` 已删除，
> 见 README「工具面：零」）。本文 §P2 提到的 `file_check` 格式巡检属**未实现的设想**，现状无该工具。

> 三个环节：**folder-path-rules** 决定文件放哪 → **匹配**决定它属于哪种文档 → **file-format-specs** 校验内容。
> 校验通过**零返回**；不符合就一次报全，让 agent 改到符合。

---

## 0. 全景

```
write / edit 落盘成功
   │
   ├─① folder-path-rules（pre-execute）  放哪、叫什么
   │
   └─② 文件匹配（post-execute）           这是哪种文档？
   │     有序匹配表，首个命中 → spec
   │     匹配不上 → 不管（静默放行）
   │
   └─③ file-format-specs（post-execute）  内容合不合规范？
         符合   → accept，零返回
         不符合 → block，一次报全所有违规 + 模板 → agent 改 → 回到 ①
```

| | 子系统 / 环节 | 目录 | 钩子 |
|---|---|---|---|
| ① | **folder-path-rules** | `.dsh/folder-path-rules/<ext>.yaml` | `tools/pre-execute` |
| ② | **文件匹配**（匹配表） | 每份 spec 自带 `match` | `tools/post-execute` |
| ③ | **file-format-specs** | `.dsh/file-format-specs/<spec>.yaml` + `<spec>.md` | `tools/post-execute` |

---

## 1. 文件匹配（本次新增的核心）

### 1.1 问题

一个文件怎么知道用哪份规范？不能「所有 md 一视同仁」——`requirement.md`、`prd-*.md`、`design/*.md` 各有各的结构要求。

### 1.2 做法：有序路径匹配表

直接借鉴 pm 插件的
[ArtifactSpec.ts](/Volumes/ORICO/doc/github/dsh/dsh-pmboard/src/domain/artifact/ArtifactSpec.ts#L114-L152)
——`NAME_TO_KIND` 是一张**有序**正则表，`kindForRelPath` 取**首个命中**，未命中回落 `notes`。

我们的版本：匹配模式由用户写在 spec 文件里，加载器汇总成有序表。

- **匹配对象**：**文件名（basename）**；需要按目录限定时再加 `match_path`
- **模式**：无 `*`/`?` 时按**关键词包含**（大小写不敏感，中文可用：`prd` 命中 prd.md / prd-需求.md / 需求-prd.md）；含 `*`/`?` 时按 glob（`**` 跨目录，用于 `match_path`）
- **示例**：`requirement`、`需求文档`、`prd-*.md`、`**/design/**/*.md`
- **优先级**：spec 的 `priority` 大者先试；同级按 spec 名稳定排序
- **首个命中即定 spec**；一个都不中 → **不校验**（无法可依，不误伤）
- **粗过滤**：spec 可声明 `ext`，先按扩展名挡一层

### 1.3 匹配规则住哪：spec 自带（自洽，不维护中央表）

新增一种文档 = 加一个 spec 文件，不用改别的表。顺序冲突用显式 `priority` 消解，一眼可读。

### 1.4 示例 spec（对照 pm 生成的文档）

```yaml
# .dsh/file-format-specs/requirement.yaml    ← 对应 pm templates/brainstorming/feature.md
name: requirement
ext: md
priority: 100
match:
  - "requirement"
  - "需求文档"
template: requirement.md
mode: block
rules:
  - id: clauses
    assert:
      fn: ids
      args:
        - prefixes: [FR, BUG, RF, SP, DOC, CH]
          unique: true
          sequence: true
  - id: fm
    assert:
      fn: frontmatterRequired
      args:
        - keys: [title, category, status]
  - id: sections
    assert:
      fn: sectionsRequired
      args:
        - headings: ["背景", "目标", "功能点", "失败与并发路径"]
```

```yaml
# .dsh/file-format-specs/prd.yaml
name: prd
ext: md
priority: 90
match:
  - "prd"
  - "产品需求"
template: prd.md
rules:
  - id: sections
    assert:
      fn: sectionsRequired
      args:
        - headings: ["背景", "用户故事", "需求清单", "验收标准"]
  - id: story-table
    assert:
      fn: tableRequired
      args:
        - under: "需求清单"
          header: ["编号", "需求", "优先级"]
```

```yaml
# .dsh/file-format-specs/design.yaml   ← 对应 pm templates/design/*.md
name: design
ext: md
priority: 80
match_path:            # 文件名定不了就用路径约束
  - "**/design/**/*.md"
template: design.md
rules:
  - id: serves
    assert: { fn: sectionsServes }     # 每个 H2 必须 serves: FR-x
  - id: tmpl
    assert: { fn: templateSections }
```

> 参考 pm 的映射关系：`requirement.md → requirement`、`design/*.md → design`、
> `decomposition.md → decomposition`、`tasks/t-xxx.md → task_detail`、
> `verification.md → verification`（见
> [registry.ts](/Volumes/ORICO/doc/github/dsh/dsh-pmboard/src/domain/template/registry.ts#L37-L192)）。
> 我们的匹配表就是这套「文档类型 → 规范」的用户可配版。

---

## 2. 校验流程与返回约定（你最关心的）

```
① 匹配命中 spec？
     否 → accept，零返回（该文件不归格式规范管）

② 跑检查 → 违规列表（全量、聚合、带行号）
   符合 → accept，零返回（静默，agent 无感）
   不符合 → block：
         · 一次报全所有违规（不是第一条就返回）
         · 附**目标结构**（有 template 文件用模板，缺则从规则推骨架）与「怎么改」
         · 附剩余尝试次数
         → agent 改完再 write/edit，回到 ①
```

**「符合就零返回」是硬约定**：合规时 `tools/post-execute` 返回 `{ kind: 'accept' }`，
不改结果、不加正文——agent 看不到任何校验痕迹。

---

## 3. 规则文件（file-format-specs）

### 3.1 布局

```
.dsh/
  folder-path-rules/
    md.yaml                 # 只管放哪、叫什么
  file-format-specs/
    requirement/            # 一个文档类型一个文件夹（目录名 = 类型名）
      spec.yaml             # 规范（匹配 + 规则；name 默认 = 目录名）
      template.md           # 骨架模板（template 默认 = 本文件）
    prd/
      spec.yaml
      template.md
    design/
      spec.yaml
      template.md
```

### 3.2 spec 字段

| 字段 | 含义 |
|---|---|
| `name` | spec 名（唯一） |
| `ext` | 可选，扩展名粗过滤 |
| `priority` | 匹配优先级，大者先（默认 0） |
| `match` | glob 列表，匹配工作区相对路径 |
| `template` | 模板正文文件（相对本目录，可选） |
| `mode` | `block`（打回）｜`warn`（只回上下文）｜`off` |
| `enforce_on` | `[create, update]`，可按新建/修改分治 |
| `diff_mode` | `delta`（只拦本次新增违规，默认）｜`strict` |
| `max_attempts` | 尝试预算（默认 3） |
| `on_exhausted` | `allow`（警告放行）｜`block`（继续拦） |
| `rules` | 规则列表（when 守卫 + assert 条件树） |
| `derive` | 前向链：派生事实 |
| `functions` | 用户自定义函数（expr / script） |

### 3.3 内置原语（引擎函数）

| fn | 参数（args[0]） | 判定（纯结构，跳过代码围栏） |
|---|---|---|
| `frontmatterRequired` | `keys[]` | front-matter 缺 key 或空值 |
| `frontmatterEnum` | `key, values[]` | 值不在值域 |
| `frontmatterPattern` | `key, pattern` | 值不匹配正则 |
| `sectionsRequired` | `headings[], order?` | 缺 H2+ 章节 / 顺序不符 |
| `sectionsForbidden` | `headings[]` | 出现禁止章节 |
| `sectionsServes` | — | 每个 H2 缺 serves 标注 |
| `tableRequired` | `under?, header[], min_rows?` | 缺表 / 缺列 / 行数不足 |
| `ids` | `prefixes[], unique?, sequence?` | 编号缺失 / 重复 / 跳号 |
| `forbiddenText` | `patterns[]` | 命中禁写文本 |
| `requiredText` | `patterns[]` | 缺必需文本 |
| `size` | `max_lines?, max_chars?` | 超长 |
| `templateSections` | —（读 `template`） | 与模板章节结构比对 |
| 取值助手 | — | `hasSection` / `sectionText` / `collectIds` / `countIds` / `frontmatter` / `length` / `count` / `matches` / `exists` |

### 3.4 动态函数：expr / script

内置原语覆盖不了的判据，由 spec.functions 里的动态函数补（逃生舱口），规则用 `fn` 调用：

- expr 函数 —— 布尔表达式，text / doc / api 可用；为假报 rule 的 message。
- script 函数 —— 函数体，返回值即违规：undefined / null / true / 空数组通过；string、或 {message,line,key,severity}、或它们的数组视为违规。
- 上下文白名单：doc（ParsedDoc）、text、fileName、relPath、specName、api（hasSection / section / collectIds / frontmatter / violation）。
- node:vm 干净上下文 + 1s 超时；函数抛错只记一条「函数执行失败」，不阻断其它规则。
- 脚本由规则作者自己写，信任层级等同项目代码，不需要额外开关。

### 3.5 规则引擎

校验核心是规则引擎，不是一堆 if：

- 事实（Facts）：文档解析结果 + 上下文（text / fileName / relPath / specName / doc / frontmatter / headings / tables / bodyLines）
- 条件树（Condition）：all / any / not / path（op: eq ne gt gte lt lte contains matches in exists empty notEmpty lengthGte…）/ each / exists / count / fn
- 规则（Rule）：when 守卫 + assert 断言，assert 不成立 → 违规；severity / priority / enabled
- 前向链（derive）：先派生事实，规则在更丰富的事实上判定
- 函数（fn）：内置原语（sectionsRequired / tableRequired / ids…）+ 取值助手（hasSection / collectIds / countIds / frontmatter…）+ 用户在 functions 里自定义（expr / script）
- spec 只声明 rules / derive / functions；没有独立的 checks 字段

执行序：初始事实 → derive → rules（priority 降序）→ 聚合违规（带行号）。

---

## 4. 执行架构

| 钩子 | 职责 | 决策 |
|---|---|---|
| `tools/pre-execute` | 路径：`write` 新建跑 decide | allow / deny |
| `tools/post-execute` | 匹配 + 格式：`write`/`edit` 成功后校验 | accept / block |

内容放**后**的原因：`edit` 的最终全文只有执行完才知道；且 `write`/`edit` 结果都带完整
`{ path, before, after }`，**不用读盘**就是真实落盘内容；一条路径覆盖新建/覆盖/增量。

结果形状：

| 工具 | 结果 value |
|---|---|
| `write` | `{ path, operation: 'create'\|'update', before: string\|null, after: string }` |
| `edit` | `{ path, before: string, after: string }` |

**auto-correct 例外**：路径纠偏由插件经宿主 `fs` 代写、原 `write` 被 pre 拦掉，不触发 post 钩子；
所以代写分支必须先跑匹配+校验，否则插件自己写不合规内容。

---

## 5. delta：存量豁免

`edit` 改一段却校验整篇，本来不合规的旧文件改个错别字也会被拦——误伤。
做法：**同时校验 `before` 与 `after`，只把「after 有、before 没有」的违规算作本次责任**。

- `write` 新建：`before === null` → 全量违规 = strict
- `write` 覆盖 / `edit`：只拦新增违规，旧问题进「建议」区
- 零容忍 spec：`diff_mode: strict`

---

## 6. 反馈契约（内容指引单）

```
⛔ 内容未通过格式规范：docs/requirements/PRD-0001/requirement.md
    匹配到的规范：requirement（模板 requirement.md）
【符合情况】3 项不符合（第 1 次，最多 3 次）

【不符合清单】
  1. [clauses] 编号跳号：FR-1 之后直接 FR-3，缺 FR-2
  2. [fm] front-matter 缺字段：category
  3. [sections] 缺章节「失败与并发路径」

【为什么】需求文档是下游设计与验收的编号契约
【模板】.dsh/file-format-specs/requirement.md（全文附在本指引内）
【怎么改】补齐 3 项后，用 write 或 edit 修同一文件；本次已一次报全
【还有】2 次机会；用尽后按 on_exhausted=allow 放行
```

同 `after` 哈希再提交 → 追加「内容未变，仍不符合」；`warning` 项列「建议」区不阻断。

---

## 7. 重试与终止

宿主天然提供循环：`block` → 结果变错误 → agent 看到原因 → 再 `write`/`edit`。插件只管：

1. 独立计数：按 `agent + canonical path`，不复用路径判定的 free-play 豁免
2. 预算：`max_attempts`（默认 3）
3. 兜底 `on_exhausted`：`allow`（accept + 警告上下文，默认）｜`block`；
   `ask` 不可用于 post 钩子（`PostToolDecision` 只有 accept/block）

干跑出口：`file_validate` 工具，不写盘先校验草稿。

---

## 8. 模块布局

```
src/content-format/match.ts       匹配：相对路径 + 有序 match 表 → spec
src/content-format/parse.ts       解析：front-matter / 标题 / 表格 / 代码围栏标记
src/content-format/spec.ts        加载 + 归一化 spec
src/content-format/primitives.ts  内置原语：每种判据一个纯函数
src/content-format/validate.ts    编排：parse → 跑检查 → 聚合 + delta 归责
src/content-format/script.ts      表达式 / 脚本沙箱
src/content-format/report.ts      内容指引单（目标模板 / 骨架 + 差异清单）
src/content-format/skeleton.ts    无模板时从规则推目标结构
src/content-format/attempts.ts    计数 + 终止
src/content-format/post-check.ts  tools/post-execute 监听
src/content-format/rules/         内容格式规则引擎
```

---

## 9. 测试

- 匹配：优先级顺序、首个命中、`**` 跨目录、无命中不校验
- 解析与每个检查原语：正例 / 反例 / 边界（空文档、空章节、代码围栏内不误判）
- delta：before 已有违规不重报；空 before = strict
- post 集成：合规 → `accept` 且**零正文**；违规 → `block` 且一次报全；超预算 → accept+警告
- auto-correct：内容违规时不代写
- 守护：示例 folder-path-rules 与 file-format-specs 可加载且自洽

---

## 10. 分期

| 阶段 | 内容 |
|---|---|
| **P0 ✅ 已实现** | folder-path-rules 改名 + 匹配表 + spec 加载 + 解析器 + 检查原语（frontmatter/sections/table/ids/forbidden-text/template-sections）+ post 钩子（符合零返回 / 不符合 block）+ delta + 代写前预校验 + 46 条测试通过 |
| **P1** | 其余检查、warning、`max_attempts`/`on_exhausted`、`file_validate`、`enforce_on` |
| **P2** | `file_check` 格式巡检、warn 模式、auto-correct 预校验、模板资产（对齐 pm templates） |

---

## 11. 待拍板

1. **匹配模式语法**：glob（`**/prd-*.md`，建议）还是正则（pm 原样）？
2. **优先级**：spec 自带 `priority`（建议）还是单独一张中央有序表？
3. **spec 目录名**：`.dsh/file-format-specs/` 是否合意？还是 `file-format-rules` / `file-specs`？
4. **兜底默认**：`on_exhausted: allow` 还是 `block`？
5. **delta 默认**：同意 delta 为默认、strict 为 spec 级选项？
6. **`write` 是否加 pre 预检**：可选 `timing: after | before | both`（默认 after）？
