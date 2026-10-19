# dsh-file-enhance 测试方案

> **2026-10-15 变更**：插件**工具面归零**——`file_resolve` / `file_propose` / `file_check` / `file_rules_init`
> 四个工具与 `src/folder-path/tools.ts` 已删除（理由见 README「工具面：零」）。本文涉及这四个工具的条目为
> **历史记录**；现状替代：宿主的 `ask_user_question`（问用户）+ 原生 `write`（改规则 yaml）。
> 用例基线：`pnpm test` = 8 个文件 / **130 条用例全绿**（decide 24、rules 10、intercept 17、index 3、format 51、docs 2、scaffold 16、scaffold-specs 7）。

> 范围：`folder-path`（放哪、叫什么）+ `content-format`（内容长什么样）+ 二者在 `tools/pre-execute` / `tools/post-execute` 上的接线。
> 本方案不写用例步骤——用例住在 `test/*.test.ts`（见 `docs/content-validation-design.md` §9）。

---

## 0. 范围

| 测 | 不测 |
|---|---|
| 判定链每条分支（pass / deny / correct）与错误码 | 宿主 `write` 工具本身的行为 |
| 规则文件的加载、归一化与非法兜底 | `.dsh/` 之外的目录约定 |
| 路径渲染、编号分配、现实结构匹配 | 非 `.md` 扩展名（无规则文件即不介入，只验证不介入） |
| 内容匹配、解析、原语、规则引擎、delta 归责 | 用户写的 spec 是否「合理」（只测「符合 spec」是否被正确判定） |
| 引单文案的关键字段（正确路径 / 分类菜单 / 目标结构） | 文案的排版美观 |
| 示例资产自洽（spec / template / example 三方一致） | — |

**测试对象的两个入口**：`installInterceptor`（pre，路径）、`installPostCheck`（post，内容）。
**唯一的接线事实源**：`src/index.ts`。任何只测下层纯函数、不测接线的用例，都不算覆盖。

---

## 1. 策略：四层，越往下越贵

| 层 | 形态 | 覆盖目标 | 现有 |
|---|---|---|---|
| L1 纯函数 | 直接调 `decide` / `renderDest` / `nextAutoNumber` / `matchSpec` / `parseDocument` / `PRIMITIVES` / `validateDocument` | 每个分支与边界，**判定链的主要战场** | ✅ `decide` / `rules` / 部分 `format` |
| L2 规则引擎 | 条件树 / 量词 / `when` / `derive` / expr / script 沙箱 | 引擎语义与失败降级 | ✅ `rules.test.ts` |
| L3 钩子接线 | 真实临时工作区 + 真实 `RulesStore` / `FormatStore`，只把宿主与 fs 换替身 | 「放行 / 打回 / 代写」三态，落盘事实 | ✅ `intercept` + `post-execute 集成` |
| L4 真机 | 装 bundle 进 DSH，让真 agent 撞一次 | 宿主契约、提示词可见性 | ❌ 手工，属发布清单 |

**为什么 L1 占比最大**：`decide.ts` 是纯函数，一条分支一个用例、毫秒级、无 IO——判定链回归几乎全押在这一层。
**为什么必须有 L3**：三态的**返回值形状**（`{kind:'deny',reason}` / `{kind:'accept'}` 零正文）是宿主的契约，纯函数测不出来。
**为什么 L4 不能自动化**：要真 agent + 真宿主 fs 服务，成本远超收益；改为每次发版照 §6 清单手工过一遍。

---

## 2. 测试点分解

### 2.1 folder-path 判定链（pre-execute）

| # | 测试点 | 等价类 / 边界 | 现状 |
|---|---|---|---|
| A1 | 类型过滤 | 无 `<ext>.yaml` → `no-rules-for-type`；非 md 文件 | ✅ |
| A2 | 根目录白名单 | 内置（README/CLAUDE…）/ yaml `root_allow` / 非白名单硬拦；**边界：第二次仍拦（无自由发挥豁免）** | ✅ |
| A3 | 主目录之外 | 首次 `outside-root` → 第二次 `free-play` | ✅ |
| A4 | 主目录下·子目录 | 现实存在目录 → `classified-reality`；规则分类 + 命名合规 → `classified-rules`；命名违规 → `naming`；都不中 → `unknown-category` | ✅ |
| A5 | 主目录下·未分类 | 现实目录优先 → `correct/reality`；规则兜底 → `correct/rules`；`adr` 走 `auto_number`；集合型变体 → `need-allocate`；都不中 → `unclassified` | ✅ |
| A6 | 集合型实例轴 | 实例存在 + 变体 → 放行；实例不存在 → `need-allocate`；编号格式非法 → `bad-instance` | ✅ |
| A7 | 规则文件非法 | `rules-invalid` 拦截并指名错误 → 第二次放行（不因坏规则卡死 agent） | ✅ |
| A8 | 代写端口 | 注入 `writeFile` 替身，验证落点 = 规范路径、内容原样 | ✅ 1 条 |
| A9 | 二次判定与记忆 | 改旧文件不拦；同一目标第二次放行；`denialTtlMs` 超时视为新尝试；**多 agent 计数隔离**（key = `agent:id`） | ⚠️ 后两条未测 |
| A10 | 指引单文案 | 根目录禁令含【可用分类】；方案 B 含【正确路径】【请重试】；方案 A 含「已按项目规范写入」 | ✅ 片段断言 |
| A11 | 原语边界 | `nextAutoNumber`（空目录→`0001`、取 max+1、补零）、`renderDest` 各占位符、`matchReality` 单复数 | ✅ 部分 |

### 2.2 content-format（post-execute）

| # | 测试点 | 等价类 / 边界 | 现状 |
|---|---|---|---|
| B1 | 匹配 | glob（`**` 跨目录 / `*` 段内 / `?` 单字符）→ 正则；无元字符按关键词包含；中文关键词；大小写不敏感；`priority` 大者先；`match_path` 附加约束；**无命中 → 不校验** | ✅ 全 |
| B2 | 解析 | front-matter / H1–H6 / 表格 / **代码围栏内的 `##` 与 `|` 不算结构** | ✅ |
| B3 | 内置原语 | `sectionsRequired`（含 `order`）/ `frontmatterRequired` / `tableRequired`（缺列、行数不足）/ `ids`（缺、重复、跳号）/ `idDetails`（核心必填、可选写了不能空） | ✅ 5 个 |
| B4 | 原语补集 | `frontmatterPattern` / `sectionsForbidden` / `sectionsServes` / `forbiddenText` / `requiredText` / `size` / `templateSections` | ⚠️ 无直接用例（部分靠示例守护间接覆盖） |
| B5 | 规则引擎 | 条件树 `all/any/not/path`、量词 `each+where`、`count`、`fn`；`when` 守卫；`derive` 前向链；用户 expr / script；`warning` 不阻断 | ✅ |
| B6 | 动态代码沙箱 | expr 真假判定；script 返回 `undefined/true/null/[]` 通过、`string`/对象/数组 违规；**抛错 → 一条「函数执行失败」不崩**；**死循环 → 超时截断** | ✅ |
| B7 | delta 归责 | `before` 已有违规不重报；`before=null`（新建）等价 strict；`edit` 整篇校验只算新增 | ✅ 前两条 |
| B8 | 反馈契约 | 合规 → `accept` **零正文**；违规 → `block` 一次报全 + 行号 + 目标结构（template 全文 / 骨架）+ 剩余次数 | ✅ |
| B9 | 重试与终止 | 按 `agent + canonical path` 独立计数；`max_attempts` 用尽 → `on_exhausted=allow` 放行并附警告 | ✅ |
| B10 | 终止与模式的其余档 | `on_exhausted: block`、`mode: off`、`diff_mode: strict` 显式用例、`sameContent` 追加「内容未变」 | ⚠️ 部分覆盖（`mode: warn`、`enforce_on` 已测） |
| B11 | 代写前预校验 | `index.ts` 的 `validateContentForWrite`：代写分支不触发 post 钩子，这条是**插件不自己写不合规内容**的唯一防线 | ✅ `index.test.ts` 覆盖策略接线与落盘 |
| B12 | 示例资产守护 | 每份示例可加载、必须有 `match` 或 `match_path`、`template` 文件存在、template 与 example 各自零 error、`owner_team` 可替代 `owner`、`status` 值域、清单有编号缺明细被拦、design 的 serves / IF 明细 | ✅ 强 |

### 2.3 非功能

| # | 测试点 | 判据 | 现状 |
|---|---|---|---|
| C1 | 校验异常不得阻断写文件 | 解析 / 正则 / 沙箱任一异常 → 降级为放行 | ⚠️ 无 |
| C2 | 路径边界 | `rawPath` 解析后落在 `workspaceRoot` 之外（`../`、绝对路径、符号链接）时的行为 | ⚠️ 无 |
| C3 | 性能 | 大 `docs/` 目录 `scanReality`、大文档 `parseDocument` 的可接受耗时 | ⚠️ 无基线 |
| C4 | 沙箱逃逸 | 脚本能否触达 `require` / `process` / `global` | ⚠️ 无 |
| C5 | 兼容 | Node ≥ 20；宿主 `@deepseek-ai/dsh-tools` 契约（`PreToolDecision` 仅 allow/deny/cancel/ask、`exec.arguments` 深度冻结） | ⚠️ 靠类型系统 |

---

## 3. 环境与数据

```
pnpm typecheck   # tsc --noEmit，先于测试
pnpm test        # vitest run --passWithNoTests
pnpm build       # tsdown → dist/index.mjs
```

| 用途 | 数据 | 维护 |
|---|---|---|
| L3 隔离工作区 | `mkdtempSync(join(tmpdir(), 'file-guide-'))` + 写入 `.dsh/folder-path-rules/md.yaml` | 每例 `beforeEach` 建、`afterEach` 清（必须有，否则偶发互相污染） |
| 路径判定输入 | 手写 `Tree` 结构（`decide.test.ts` 的 `tree()`），**不依赖真实磁盘** | 随 `types.ts` 的 `Tree` 变更同步 |
| 守护数据 | `examples/md.yaml`、`examples/file-format-specs/**` | **随包资产 = 测试数据**，改资产即改契约 |
| 现实结构样本 | 真实仓库 `docs/`（`scanReality` 的生产输入） | 只读，不写断言死值 |

**替身边界**：只替换宿主与磁盘（`writeFile` / `exists` / `mkdirp`），**不替换** `RulesStore`、`FormatStore`、`decide`、`validateDocument`——否则 L3 退化成 L1。

---

## 4. 准入 / 准出

**准入**：设计文档结论已冻结（`content-validation-design.md` §11 的待拍板项已拍）；规则 schema 变更已同步 `examples/`。

**准出（硬指标，缺一不发）**：

1. `pnpm typecheck` 零错误
2. `pnpm test` 全绿（当前 80/80，只增不减）
3. 判定链每个 `code` 至少一条用例；新增 `code` 必须同 PR 补用例
4. 示例资产守护全绿（template / example / spec 三方自洽）
5. §5 的 P0 缺口清零
6. §6 真机清单手工过一遍并留结论
7. 无 P0/P1 未修缺陷

**不设覆盖率数字门槛**：判定链分支数比行覆盖率更能说明问题，用第 3 条代替。

---

## 5. 缺口与补测优先级

| 优先级 | 缺口 | 为什么危险 |
|---|---|---|
| **P0** | 代写失败降级（`writeFile` 抛错 → `deny` + 指引单 + `bump`）未测 | 无权限 / 目录冲突时 agent 会拿到什么，未知 |
| **P0** | post 钩子的 `edit` 分支（`op=update`、`before≠null`）未测 | `edit` 是日常路径，delta 归责写错就是大面积误伤 |
| **P0** | C1 校验异常降级为放行 | 校验器一旦抛错就阻断写文件，比不校验更糟 |
| **P0** | C2 路径穿越 | 规范路径算到工作区之外是越权写入 |
| P1 | A9 `denialTtlMs` 超时、多 agent 计数隔离 | 记忆串味会让「第二次放行」提前或滞后 |
| P1 | B10 `on_exhausted: block` / `off` / `strict` / `sameContent` | `warn` 与 `enforce_on` 已补测，其余声明行为仍缺显式用例 |
| P1 | B4 七个原语无直接用例 | 靠示例间接覆盖，改坏一个不一定会红 |
| P1 | 四个工具（`file_resolve` / `file_propose` / `file_check` / `file_rules_init`）无测试文件 | 用户唯一的手动入口，目前只有「内置文本与 examples 一致」一条守护 |
| P1 | `scanReality` / 规则 mtime 热重载 | 规则改完即生效是核心承诺，无回归网 |
| P2 | C3 性能基线、C4 沙箱逃逸、并发写同路径 | 出问题不会静默，可接受后置 |

---

## 6. 真机发布清单（L4，每次发版手工）

> 2026-10-15 在 DSH 桌面宿主 0.2.0-rc.2 上跑过一轮（host pid 24037），结论附在每条后面。

- [x] `pnpm build` 产物装进 DSH，`plugin_manager` 列表可见 —— `link:` 安装，`include:dsh-file-enhance` active
- [x] 让 agent 在根目录建 `notes.md` → 被打回，指引单里有【可用分类】 —— 打回；且**第二次仍拦**（硬拦永不豁免，已修 footer 文案不再误导）
- [x] `autoCorrect: true`：未分类文件被代写到规范路径，**落点与回执一致** —— `docs/login-guide.md` → 代写 `docs/guides/login-guide.md`，回执一致
- [ ] `autoCorrect: false`：文件不落盘，指引单给出【正确路径】，agent 重试后放行 —— L3 有替身测试；真机未跑（需改 bundle config 再重启宿主）
- [x] 装上 `file-format-specs`，让 agent 写一份缺章节的 PRD → 收到一次报全的违规清单 + 目标模板 —— 26 项一次报全，含目标模板 / 剩余次数 / example 指针
- [x] agent 按指引修好后重写 → **零返回**，对话里看不到任何校验痕迹 —— 模板原文重写，工具结果无校验输出
- [ ] 改旧的不合规文件 → 只拦本次新增违规（delta 生效）—— L3 有 `before` 归责测试；真机未单独跑
- [x] 改 `.dsh/**/*.yaml` 后不重启 → 新规则立即生效 —— `root_allow` 加白后同路径立即放行（mtime 热重载）
- [ ] 无 `fs` 服务时（子代理 / 无 UI）→ 代写回落 `node:fs`，`file_propose` 退化为文字提议 —— 未跑；实测到的是更常见的「有 userQuestions 服务但无应答者」：`file_propose` 报错**且不写入**（不伪造批准）

真机修复记录（这轮 L4 打出来的缺陷，已修）：

1. **工作区根错位**：桌面宿主 `process.cwd()` = profile 目录。改为 `resolveRoot(exec)` 按 agent 解析（`workingDirectory` 服务 → `session.header.cwd` → `process.cwd()` 回落），stores 支持按调用传 root。
2. **四个工具缺 `output.render`**：dsh-tools ≥0.2.0-rc.2 的 `register()` 强制要求；补上 JSON 文本渲染。
3. **工具输出含 `undefined` 属性**：宿主要求 lossless JSON（`file_resolve` 的 `template: undefined` 触发拒收）；返回前统一剔除。
4. **依赖布局**：`@deepseek-ai/dsh-tools` 从 `dependencies` 改为 `peerDependencies ^0.2.0-rc.1` + `devDependencies`（与宿主共享实例）。
5. **热更新限制**：宿主进程 ESM 缓存 bundle 模块，`set_bundle` / remove+install 都不重读盘（入口文件第一行 `throw` 都拦不住旧代码运行）；改代码后必须重启宿主进程（GUI 无需退出，TERM host 进程即会被主进程自动拉起）。

---

## 7. 风险

| 风险 | 对策 |
|---|---|
| 宿主 API 变更（`PreToolDecision` 档位、`exec.arguments` 冻结） | 类型系统 + L3 的返回值形状断言；升级宿主版本时先跑 §6 |
| 校验误伤存量文件 | `diff_mode: delta` 为默认，`strict` 需显式声明；新项目接入先跑 `file_check` 巡检 |
| 插件自身写盘越权 | 优先走宿主 `fs` 服务（策略/审计仍归宿主）；C2 补测后收口 |
| 动态代码失控 | 1s 超时 + 白名单上下文 + 抛错降级；补 C4 |
| 规则写得不对导致全线打回 | `rules-invalid` 首次拦截、第二次放行（已有用例守护） |

---

## 8. 分期

| 阶段 | 内容 |
|---|---|
| **P0** | 补齐 §5 五条 P0 缺口；`pnpm test` 从 80 条增至 ~95 条 |
| **P1** | §5 的 P1 条目；新增 `test/tools.test.ts` |
| **P2** | 性能基线、沙箱逃逸、并发；真机清单固化为可执行的冒烟脚本 |
