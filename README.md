# dsh-file-enhance

[![CI](https://github.com/kakaCat/dsh-file-enhance/actions/workflows/ci.yml/badge.svg)](https://github.com/kakaCat/dsh-file-enhance/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kakaCat/dsh-file-enhance)](https://github.com/kakaCat/dsh-file-enhance/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.0--rc.1-blue)](package.json)
[![Node ≥ 20](https://img.shields.io/badge/node-%3E%3D%2020-339933)](package.json)
[![GitHub repo](https://img.shields.io/badge/github-kakaCat%2Fdsh--file--enhance-blue)](https://github.com/kakaCat/dsh-file-enhance)

DSH 插件：**让 agent 按项目自己的规范创建文件**——新文件按类型归位、文档按规范校验。
规则住在工作区 `.dsh/` 里，改完即生效；插件**不注册任何工具**，只在原生 `write` / `edit` 上做加强。

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 效果预览

**未分类 → 自动纠偏**（默认策略，agent 不用重试）：

```
路径不合规，本次 write 未执行。
该文件已按项目规范写入：docs/guides/login-guide.md
  · 你请求的路径：docs/login-guide.md（未分类，已自动归位）
  · 判据来源：项目规范｜分类：guides
  · 不要再用原路径重试；后续同类文件请直接使用 docs/guides/login-guide.md
```

**内容不合规 → 一次报全 + 目标模板**：

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
【怎么改】把文档改成上面的目标结构，并逐条修正不符合项；用 write 或 edit 修同一文件
```

**规则没覆盖 → 打回附一张指引单**（正确路径 + `docs/` 现状 + 分类菜单 + 下一步），
见[路径规则文档](docs/folder-path-rules.md#回执长什么样)。

## 特性

- **两个子系统，各管一件事**：`folder-path-rules/<ext>.yaml` 管「放哪、叫什么」；
  `file-format-specs/<type>/` 管「内容长什么样」。互不重叠，可以只开其中一个。
- **零工具面**：不注册任何工具。工具名 + description 是常驻 system prompt 的，注册工具等于把规则面挂上去。
- **规则不常驻**：规范不进 prompt，只在**被拦下的那一刻**随工具结果出现——附正确路径、`docs/` 现状、分类菜单、目标模板。
- **自动纠偏**：未分类文件由插件按规范路径代写（经宿主 `fs` 服务，落点已存在不覆盖），agent 一次都不用重试。
- **目录现状优先**：老项目接入顺着已有结构走，规则只兜底——实测 4970 份真实文档 **99% 放行**。
- **规则热重载**：改 yaml 即时生效，不重启；`fileEnhance.status()` 能读出哪份规则写坏了。
- **文档规范是数据**：条件树 + 13 个内置原语 + `derive` 前向链 + `expr`/`script` 逃生舱（vm 白名单、1 秒超时）。
- **delta 归责**：只算本次新增的违规，旧文件的历史问题不背锅；重试预算与 `on_exhausted` 可配。
- **随包五套规范**：requirement / prd / design / metrics / research，与 `examples/` 逐字节一致（测试守护）。

## 什么时候用它

| 适合 | 不适合 |
|---|---|
| 团队对文档落点与结构有约定，但只能靠 prompt 提醒 | 想让插件替 agent 写内容、做评审——它不判「写得好不好」 |
| 新会话总把文件丢在根目录或全塞进 `docs/` | 想治理**存量**乱文件——它只看新建，结构上看不见旧文件 |
| 需求 / PRD / 设计 / 调研要机器可验的结构 | 非 markdown、或没有约定的文件类型（不放规则就不拦） |
| 同一份约定要在多个 agent 会话间保持一致 | 想要文档 GUI——它没有界面、没有路由 |

## 快速上手

```bash
cp examples/md.yaml .dsh/folder-path-rules/md.yaml          # 1. 路径规则（不建也行，冷启动会落一份默认）
cp -r examples/file-format-specs .dsh/file-format-specs     # 2. 内容规范（按需删掉不要的类型）
```

3. 让 agent 建一个 `docs/登录指南.md` —— 未分类会被**自动纠偏**到 `docs/guides/`，回执告诉它实际落点。

规则改完即时生效，不需要重启。想知道默认规则在你项目上会不会误伤，跑
`node scripts/calibrate-defaults.mjs <仓库根>`（见[实测](#它会不会误伤我实测)）。

## 安装与卸载

**前置**：Node ≥ 20（构建需 ≥ 22.18）；DSH 满足 `engines.dsh`（见[兼容性](#兼容性)）。

**第一步，出产物**——`dist/` 不入库，跳过这步会装出一个 import 失败的插件：

```bash
git clone https://github.com/kakaCat/dsh-file-enhance.git
cd dsh-file-enhance
pnpm install && pnpm build       # → dist/index.mjs + dist/index.d.mts
pnpm check:dist                  # 可选：冒烟检查入口 / 插件契约 / bundle patch / 清单本地化
```

**第二步，装进 profile**（二选一）：会话里 `plugin_manager` → `install_bundle`（target 指向仓库目录或 tarball）；
或命令行 `dsh plugin --profile <profile> add <仓库绝对路径>`。

> 两条路都**不会**替你构建：对本地目录走 pnpm link，`prepack` 不触发。所以第一步不能省。

装好后重启宿主。判据：插件清单里出现 `dsh-file-enhance`，中文界面显示「文件规范增强」（文案来自 [locale/](locale/)）。

**卸载**：`dsh plugin --profile <profile> remove dsh-file-enhance`。卸载**不删**工作区 `.dsh/`——那是你的规则资产。

## 路径规则：放哪、叫什么

一个文件类型一个文件，`.dsh/folder-path-rules/md.yaml` 管 `*.md`：

```yaml
root: docs                 # 该类型的主目录
root_allow: [TODO.md]      # 根目录白名单

categories:
  guides:
    folder: guides
    keywords: [指南, 教程, guide, tutorial]
    dest: "guides/{slug}.md"

  adr:
    folder: adr
    keywords: [决策, adr, decision]
    dest: "adr/{auto_number:4}-{slug}.md"     # 扫目录取 max+1，补 4 位
```

判定链一句话：**扩展名过滤 → 根目录白名单 → 主目录归属 → 现实目录优先 → 分类兜底 → 自由发挥**。
优先级是 `目录现状 > yaml 规则 > 自由发挥`；同一目标第二次尝试即放行（根目录禁令除外）。

占位符、集合型分类（`PRJ-xxxx` 实例目录）、纠偏的两种策略、常见改法，都在
[路径规则文档](docs/folder-path-rules.md)；完整示例见 [examples/md.yaml](examples/md.yaml)。

## 内容规范：长什么样

```
.dsh/file-format-specs/
  <type>/                     # 目录名 = 类型名
    spec.yaml                 # 规范：match + rules
    template.md               # 骨架（打回时内联）
    example.md                # 可选：填好的参考（只给路径指针）
```

```yaml
# .dsh/file-format-specs/prd/spec.yaml
match: ["prd", "产品需求"]     # 文件名匹配：无 * ? = 关键词包含，有 = glob
mode: block                    # block 打回 | warn 只提示 | off
diff_mode: delta               # delta 只拦本次新增 | strict 全量
max_attempts: 3
on_exhausted: allow            # 用尽后 allow 放行 | block 继续拦

rules:
  - id: sections
    assert: { fn: sectionsRequired, args: [{ order: true, headings: [摘要, 背景与问题, …] }] }
  - id: fr-table
    assert: { fn: tableRequired, args: [{ under: 功能需求, header: [编号, 需求, 优先级, 验收判据] }] }
```

校验发生在 `write` / `edit` **落盘之后**（`post-execute`），因此 `edit` 的 `before` / `after` 都在手里，
才能做 delta 归责。打回只改变工具结果，不回滚已落盘内容。

原语清单、条件树、`derive` 前向链、`functions` 逃生舱与沙箱边界，见
[模板与规则契约](docs/template-authoring.md) 与 [格式校验设计](docs/content-validation-design.md)。

## Host 服务：fileEnhance

插件装载时 `ctx.provide('fileEnhance', …)`，供上层在**动手之前**预置规范：

| 方法 | 作用 | 写盘纪律 |
|---|---|---|
| `ensure(root)` | 预置默认规范，幂等 | 只写缺失文件 |
| `status(root)` | 读生效类型 + 坏掉的（`invalid`）/ 缺文件的（`missing`）连同原因 | 不写盘 |
| `provision(root, profile)` | 按 `{ rules, formats }` 落指定规范 | 先整体校验，非法输入抛 `FileEnhanceError`，一个字节都不写 |

## 配置

装载行在 [cordis.patch.yml](cordis.patch.yml)（`id: dsh-file-enhance`）。**规则不在这里配**——规则住工作区 `.dsh/`。

| 配置 | 默认 | 含义 |
|---|---|---|
| `autoCorrect` | `true` | 未分类时由插件代写到规范路径；`false` = 打回让 agent 重试 |
| `contentValidate` | `true` | 是否挂内容格式校验（`post-execute`） |
| `scaffoldDefault` | `true` | 冷启动垫片：无规则时回落内置默认并落盘；`false` = 无规则即放行 |

## 它会不会误伤我（实测）

拿 4970 份真实文档（pmboard / deepseek-harness / dataforge / taskmaster）跑随包默认：
**放行 99%｜纠偏 0%｜打回 1%**——原因是判定链第一原则「目录现状优先」，文件已在真实目录里就不插手。
新建一份典型文档：9/12 归到对应目录（prd / guides / adr / research / api），1/12 原样放行（`docs/test-plan.md` 这类项目级文档，`meta` 分类的 dest 就是当前位置），2/12 打回一次（`notes.md` / `meeting-*.md` 这种没有主题词的裸文件名，第二次放行）。

复现（先 `pnpm build`）：`node scripts/calibrate-defaults.mjs <仓库根…>`，加 `--new` 只看新文件那一半。
数字会随仓库漂移，脚本用于校准，不进测试断言。

## 兼容性

| 项 | 要求 |
|---|---|
| DSH | `>=0.2.0-rc.1 <0.3.0`（`engines.dsh`；不满足时**安装与启动都拒绝**） |
| Node.js | ≥ 20（运行时）；≥ 22.18（构建、`pnpm pack`、CI） |
| 宿主服务 | `tools`（必需）；`fs`（可选，缺失时代写回落 `node:fs`）；`workingDirectory`（可选，缺失时回落 `session.header.cwd` → `process.cwd()`） |
| 平台 | 与宿主一致（CLI / Desktop / Web 均可——本插件没有客户端半） |
| 工具面 | `write` / `edit`（宿主原生）。只拦 `write` 的**新建**，`edit` 只走内容校验 |

## 已知边界

边界是有意画的，不是缺功能：

- **只拦 `write` 新建的 `.md`**：非 md 不管；`bash` 里 `echo > x.md` 绕得过去（靠 prompt 纪律兜底）。
- **不管存量与改旧文件**：判定链只在「目标文件不存在」时跑；命中已存在目标时路径直接放行（内容校验仍生效）。
- **不能改工具入参**：`exec.arguments` 深度冻结、`PreToolDecision` 没有「改参数」一档，故默认由插件代写。
- **内容校验晚于落盘**：不合规时文件已写入，`block` 把工具结果变成错误让 agent 修；预算见 `max_attempts` / `on_exhausted`。
- **路径规则先于内容规范命中**：被路径拦下的文件走不到内容校验——别让两条分类抢同一个关键词
  （随包规则为此把 PRD 单列一类，并把 `prd` / `产品需求` 从 `project` 关键词里拿掉）。
- **同一目标连拦一次即放行**：根目录禁令不适用此豁免；拦截记忆保留 10 分钟。
- **工作区根按 agent 解析**，不是插件进程 cwd：`workingDirectory` → `session.header.cwd` → `process.cwd()`。
- **改插件代码后需重启宿主**：ESM 模块缓存，HMR 不监视 `node_modules` 里的 bundle。

## 数据与隐私

- **只读**工作区里的规则与规范（`.dsh/folder-path-rules/*.yaml`、`.dsh/file-format-specs/**` 及其模板/示例），不遍历其它文件。
- **写盘只有两处**：冷启动垫片落默认规则（逐文件 `wx`，存在即跳过）、自动纠偏代写新文件（落点已存在不覆盖；有 `fs` 服务时经它写）。
- **不联网、不采集、不上报**；全部判定在本地进程内完成，无 LLM 调用。
- **用户脚本**在 `node:vm` 新上下文执行，只注入 `doc` / `text` / `fileName` / `relPath` / `specName` / `api`，单次 1 秒超时。
  **`node:vm` 不是安全边界**——信任模型是「规则文件 = 项目代码」，别把不可信来源的 `spec.yaml` 放进工作区。

## 开发

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest：10 个文件 / 178 条用例
pnpm build       # tsdown → dist/
pnpm check:dist  # build 之后跑：入口文件、插件契约、bundle patch、清单本地化
```

> **Node 版本**：`pnpm build` 需要 **Node ≥22.18**（tsdown 的引擎要求）；产物目标是 Node 20，运行时满足 `engines.node` 即可。

```
src/index.ts               插件入口（只 inject tools，挂两个监听器；不注册任何工具）
src/folder-path/           路径子系统（rules 加载 / decide 判定链 / guidance 指引单 / intercept 钩子）
src/content-format/        内容子系统（spec 加载 / parse / primitives / 规则引擎 / report / post-check）
src/host/service.ts        Host 服务 fileEnhance（ensure / status / provision）
examples/md.yaml           随包路径规则示例
examples/file-format-specs/<type>/   随包内容规范（spec.yaml + template.md + example.md）
docs/                      设计文档与下沉细节（folder-path-rules / template-authoring / content-validation-design / test-plan）
scripts/                   sync-builtin-specs / smoke-dist / calibrate-defaults
locale/                    插件清单本地化（zh / en）
test/                      vitest：decide / intercept / rules / format / docs / service / scaffold / perf
```

## 相关文档

- [路径规则](docs/folder-path-rules.md)——判定链每个分支、规则字段、纠偏策略、常见改法
- [模板与规则契约](docs/template-authoring.md)——模板结构、占位符、五套示例的设计来源
- [格式校验设计](docs/content-validation-design.md)——匹配、解析、原语、规则引擎的实现细节
- [测试方案](docs/test-plan.md)——覆盖范围、缺口与实测记录
- [设计评审模板](docs/design-review-template.md)——90 分钟、有结论、能追责的评审怎么开（模板类资产）
- [date-prefix 方案](docs/date-prefix-design.md)——文件名带日期的占位符设计（**提案，未实现**）
- [插件分工调研](docs/research/研发设计调研报告-文档模板类插件分工与集成方案.md)——与 pmboard 模板体系的分工（**调研方案，D-1/D-2 未裁决**）
- [更新日志](CHANGELOG.md)——版本与变更

## 贡献

欢迎 issue 与 PR。提交前跑 `pnpm typecheck && pnpm test && pnpm build && pnpm check:dist`（CI 在 Node 22 上跑同样四条）。
改 `examples/` 下的规范后记得 `pnpm sync:specs`，否则 `test/scaffold-specs.test.ts` 会红。发布说明写在
`.github/release-notes/<tag>.md`，推上去由 Actions 同步到 GitHub Release。

## License

[MIT](LICENSE) © 2026 kakaCat

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
