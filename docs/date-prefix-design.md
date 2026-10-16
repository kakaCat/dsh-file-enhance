# 需求方案：文件名「时间 + 名称」设计（date-prefix）

> 状态：需求提案（待评审）
> 影响面：路径子系统（`folder-path`）——`dest` 模板渲染、命名校验、纠偏与指引单
> 不影响：内容子系统（`content-format`）、既有占位符 `{slug}` `{auto_number}` `{project_id}` 的语义

---

## 1. 背景与问题

现状 `dest` 模板支持 `{slug}`、`{auto_number:4}`、`{project_id}`，但没有**时间**维度。两类真实诉求满足不了：

1. **日志 / 日记 / 会议纪要 / 调研记录**类文件，天然按天产生：`docs/daily/2025-10-15-晨会纪要.md`——人想看的是「哪天的」，文件名里没有日期就得点开看，目录按时间排序也失去意义。
2. **同日多次产出**时，`{slug}` 容易撞名（`note.md`、`note-2.md`…）；加日期前缀后 `2025-10-15-note.md` 自带去重维度，且跨天不冲突。

目标：**创建文件时，文件名为「时间 + 名称」的组合**，规则仍住在 `.dsh/folder-path-rules/<ext>.yaml` 里，由用户声明、改完即生效——与插件「你是唯一权威」的原则一致。

## 2. 设计总览

### 2.1 核心：三个新占位符

在 `dest` 模板中新增时间占位符，与现有占位符同一套渲染机制（[decide.ts](../src/folder-path/decide.ts) `renderDest`）：

| 占位符 | 含义 | 默认格式 | 示例输出 |
|---|---|---|---|
| `{date}` | 创建当天的本地日期 | `YYYY-MM-DD` | `2025-10-15` |
| `{date:FMT}` | 同上，自定义格式 | — | `{date:YYYYMMDD}` → `20251015`；`{date:YYYY/MM}` → `2025/10` |
| `{time}` | 创建时刻的本地时间 | `HHmm` | `2317` |
| `{time:FMT}` | 同上，自定义格式 | — | `{time:HHmmss}` → `231705` |
| `{datetime}` | 日期 + 分隔符 + 时间 | `YYYY-MM-DD_HHmm` | `2025-10-15_2317` |
| `{datetime:FMT}` | 同上，自定义格式 | — | `{datetime:YYYYMMDD-HHmmss}` → `20251015-231705` |

- **格式 token**：仅认 `YYYY` `MM` `DD` `HH` `mm` `ss`（区分大小写）；其余字符原样保留（所以 `YYYY/MM` 能当目录分隔符用）。
- **时间来源**：宿主本机时钟、本地时区，取**判定那一刻**（`decide` 执行时）——不联网、不读文件 mtime（创建语义以「下单时刻」为准）。
- 时间占位符可出现在 `dest` 的**任意路径段**：文件名前缀（主用途）、目录段（按月归档 `{date:YYYY/MM}/{slug}.md`，v1 不做但语法上自然支持）。

### 2.2 声明方式：全部收敛在 `dest` 里

不新增顶层字段，不新增 naming 枚举值。用户要时间前缀，就在 `dest` 里写占位符：

```yaml
# .dsh/folder-path-rules/md.yaml
categories:
  daily:
    folder: daily
    keywords: [日记, 日志, daily, journal, 晨会, 纪要]
    dest: "daily/{date}-{slug}.md"            # → docs/daily/2025-10-15-晨会纪要.md

  minutes:
    folder: minutes
    keywords: [会议, 纪要, meeting, minutes]
    dest: "minutes/{date:YYYYMMDD}/{slug}.md" # → docs/minutes/20251015/评审.md

  research:
    folder: research
    keywords: [调研, research]
    dest: "research/{date}-{slug}.md"         # 存量目录平滑接入：校验随之放宽（见 §3）
```

与 `{auto_number}` 可组合：`"adr/{date}-{auto_number:4}-{slug}.md"`（按天各自编号）。

## 3. 判定链改动点

### 3.1 渲染（`renderDest`）

新增一段分支：命中 `{date[:fmt]}` / `{time[:fmt]}` / `{datetime[:fmt]}` 时格式化本机时间替换。**纯函数退化**：`renderDest` 目前无时钟依赖，为可测试性把时间作为可选入参注入（缺省 `new Date()`），测试传固定时钟。

### 3.2 命名校验放宽（`matchesNaming` / `decide` ④⑤ 分支）

问题：分类 `dest` 含时间占位符后，目录里既有文件可能是 `2025-10-15-晨会纪要.md`，纯 `kebab-case` 校验过不了（数字段不是小写字母）。

规则：**当分类（或变体）的 `dest` 含时间占位符时，命名校验改为「可选时间前缀 + 命名风格」**——

```
stem  = [日期串][-时间串] - slug
日期串 ≈ ^\d{4}-\d{2}-\d{2}$ 或 ^\d{8}$（按 dest 里的格式反推，不做过严校验：存在即剥掉）
剥掉前缀后剩余部分按原 naming 校验
```

- 反推格式以 `dest` 声明为准（`{date:YYYYMMDD}` → 剥 8 位纯数字；`{date}` → 剥 `YYYY-MM-DD`），剥不掉就走旧逻辑（视为无前缀文件，按原 naming 判），**不因格式歧义误杀**。
- 仅放宽「前缀」位置；时间串出现在中间/后缀的存量文件仍按原 naming 判（保持简单，不猜意图）。

### 3.3 纠偏（自动归位）

链路不变：agent 写 `docs/daily/晨会纪要.md` → 判定「未带日期前缀」→ 按 `dest` 渲染出 `docs/daily/2025-10-15-晨会纪要.md` 自动代写 / 或打回附【正确路径】。回执文案中明确写出渲染结果与时间取值：

```
路径不合规，本次 write 未执行。
该文件已按项目规范写入：docs/daily/2025-10-15-晨会纪要.md
  · 你请求的路径：docs/daily/晨会纪要.md（缺日期前缀，已按规范补齐）
  · 时间取值：2025-10-15（本机日期）
```

### 3.4 撞名处理（新增一条 deny）

同日同 slug 再创建时，目标文件**已存在**——不允许静默覆盖：

- 自动纠偏路径：渲染结果已存在 → 不代写，打回 `date-collision`，附建议（改 slug，或带 `{time}` 的分类自动降级到分钟级 `…_2317.md` 重渲染一次）。
- `{time}` 参与渲染的分类天然免疫（分钟级重复概率忽略）。

## 4. 明确不做（Non-goals）

| 不做 | 理由 |
|---|---|
| 存量文件批量重命名 | 只约束「创建」这一刻，与老文件无关；rename 属于另一个工具/流程 |
| 时间语义放进内容子系统 | frontmatter 里的 `date:` 字段由 `file-format-specs` 管，本方案只管文件名 |
| 命名风格新枚举（如 `date-kebab`） | `dest` 占位符已能表达，加枚举是第二种语法，徒增维护 |
| 多时区 / UTC 切换 | 本机时区够用；真有需要再加全局配置项 |
| 用 mtime / 文件内容推断时间 | 创建语义以判定时刻为准，可预期、可测试 |

## 5. 兼容性

- 存量规则文件**零改动**：不含时间占位符的 `dest` 走原路径，渲染与校验逐字节不变。
- 新增占位符只做「加法」：`normalizeRules` 不新增必填项；非法格式 token 在加载期抛错（沿用现有「规则非法 → 首次打回、附错误详情」的机制）。
- 指引单（`guidance.ts`）展示分类菜单时原样列出 `dest`，时间占位符可见即所得，无需特殊处理。

## 6. 验收判据

1. `dest: "daily/{date}-{slug}.md"` 下，agent 创建 `docs/daily/x.md` → 纠偏/打回路径为 `docs/daily/<当天>-x.md`（测试注入固定时钟，断言精确字符串）。
2. 上述分类下，`docs/daily/2025-10-15-x.md` 通过命名校验；`docs/daily/x.md`（第二次，自由发挥豁免）仍放行（与既有「第二次放行」语义一致）。
3. `dest: "minutes/{date:YYYYMMDD}/{slug}.md"` 可渲染出**目录段**，且子目录不存在时按纠偏代写逻辑 recursive 建出。
4. `{date}` 与 `{auto_number:4}` 组合时，编号按渲染后目录内已有文件取 max+1，不因日期段干扰。
5. 渲染结果已存在 → 打回 `date-collision`，文件未被覆盖。
6. 存量 yaml（无时间占位符）全部现有测试保持绿。
7. 回执/指引单文案含时间取值说明（见 §3.3）。

## 7. 里程碑拆解（建议）

| 步骤 | 内容 | 验证 |
|---|---|---|
| M1 | `renderDest` 时间占位符 + 时钟注入 | 渲染单测（格式 token 全表） |
| M2 | 命名校验放宽（剥前缀 + 原 naming） | decide 单测（有/无前缀、剥不掉、第二次放行） |
| M3 | 纠偏链路接线 + 撞名 deny | intercept/decide 集成测试、回执文案 |
| M4 | `examples/md.yaml` 增加 `daily` 分类示例 + README 占位符表更新 | 文档与示例走查 |

---

**一句话总结**：时间维度不新增概念，只是 `dest` 模板里的三个新占位符；命名校验随声明自动放宽；撞名显式打回。存量规则零影响。
