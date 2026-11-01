# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 文档

- README 新增「默认规则的杀伤面（实测）」：4970 份真实文档上 99% 放行、新文件 9/12 自动归位，
  并说明「设计文档按项目归属」这个取舍；附 `scripts/calibrate-defaults.mjs` 可复现。

## [0.1.5] - 2026-11-01

修一个「两个子系统互相截胡」的默认配置问题：PRD 文档之前走不到 prd 内容规范。

### 修正

- **随包默认规则给 PRD 单列一类**：新增 `prd` 分类（`docs/prd/{slug}.md`，关键词 `prd` / `产品需求`），
  并从 `project` 集合型分类的关键词里拿掉 `prd`。
  过去 `docs/prd-登录.md` 会被 `project` 判成「要先有 PRJ-xxxx 实例目录」，
  而路径判定在 `pre-execute`、内容校验在 `post-execute`——于是 prd 内容规范永远没有机会执行。
  现在 `docs/prd-登录.md` → 纠偏到 `docs/prd/prd-登录.md` → 命中 prd 规范校验。

### 说明

- 已用自己 `.dsh/folder-path-rules/md.yaml` 的项目**不受影响**（工作区规则优先于内置默认）；
  想用新默认就把工作区那份删掉，或照 `examples/md.yaml` 手工加这一段。

## [0.1.4] - 2026-11-01

### 改进

- **并发写同一落点**：回执不再笼统报「自动纠偏失败」，而是区分「落点刚被另一次写入占用（并发）」，
  并提示改用 `edit` 或换文件名——`wx` 语义本来就是拒绝覆盖，说清楚比报失败有用。
- **文档**：把「路径规则先于内容规范命中」的坑写进随包 `md.yaml` 与 README 已知边界
  （`project` 关键词含 `prd`，会让 `docs/prd-*.md` 走不到 `prd` 内容规范）。

### 工程

- 用例 173 → 175：并发写同落点（一个成功一个被拒、内容不撕裂）、`EEXIST` 回执文案。

## [0.1.3] - 2026-11-01

只加测试，无实现变更。

### 工程

- **沙箱白名单边界用例**：`functions.script` 里 `process` / `require` / `fs` 必须不可见，
  同时 `doc` / `text` / `api` 仍然可用——把「注入口子有没有开大」钉成回归网。
- 用例 172 → 173。

## [0.1.2] - 2026-11-01

补测 P1 缺口时暴露一个原语口径错误；其余为测试与基线，无其他行为变更。

### 修正

- **`sectionsServes` 只认 H2**：文档口径是「每个**结构节（H2）**必须带 `serves:`」，实现却用
  `level < 2` 跳过，等于 H3 小节也被要求写 serves——与 `sectionsRequired` 的口径不一致。
  现在与设计文档对齐：H3 及更深不再判定。
  **受影响的 spec**：用 `sectionsServes` 且文档里有不带 serves 的 H3 小节的，之前会误报，现在不会。

### 工程

- 测试方案里剩余的 P1 / P2 缺口全部关闭：
  - **B4**：7 个原语（`frontmatterPattern` / `sectionsForbidden` / `sectionsServes` / `forbiddenText` /
    `requiredText` / `size` / `templateSections`）全部有直接用例；
  - **B10**：`on_exhausted: block`（用尽不放行）、`mode: off`（零返回）、`diff_mode: strict`（改写照报）、
    `sameContent`（「与你上次被拒的一致」）四条显式用例；
  - **A9**：多 agent 计数隔离（A 的第二次放行不影响 B 的首次）；
  - **mtime 热重载**：改规则并推进 mtime 后，同一条记忆下立即按新规则放行，无需重启；
  - **NFR-1 性能基线**：新增 `test/perf.test.ts`，prd 规范 × 1171 行文档，
    本机 min 0.43ms / p95 2.20ms（预算 50ms），读数打在测试输出里。
- 用例 159 → 172（10 个文件）。

## [0.1.1] - 2026-11-01

安全与鲁棒性修复，无行为变更（合规路径的表现与 0.1.0 完全一致）。

### 修正

- **落点不出工作区（路径穿越）**：`dest` 模板写成 `../../x` 时，`join()` 会把文件写到工作区之外。
  现在代写前校验落点与规则 `root` 都必须在工作区内，越界一律拒写并说明原因。
- **判定链 / 校验器异常降级为放行**：`pre-execute` 与 `post-execute` 两个监听器都加了兜底——
  插件自己的 bug 只写一条 warn，绝不把写文件整条链路带崩（文件已经落盘时尤其不能）。
- **`instance.pattern` 加载期校验**：非法正则过去会在 `decide()` 里 `new RegExp(...)` 抛错，
  表现是「写文件直接失败」；现在被点名成「规则文件非法」，并出现在 `status().invalid` 里。

### 工程

- 测试方案里挂了 4 条 P0 缺口全部关闭：代写失败降级、`edit` 分支的 delta 归责、
  校验异常降级、路径穿越；用例 152 → 159。

## [0.1.0] - 2026-11-01

首个开源版本。两条互相独立的加强线：**路径**（放哪、叫什么）与**内容**（长什么样），
都只在宿主原生 `write` / `edit` 的行为上加一层——插件不注册任何工具。

### 新增

- **路径子系统**：按 `.dsh/folder-path-rules/<ext>.yaml` 约束新建文件的落点与命名。判定链为
  「扩展名过滤 → 根目录白名单 → 主目录归属 → 现实目录优先 → 分类兜底 → 自由发挥」，优先级是
  **目录现状 > yaml 规则 > 自由发挥**；规则按 mtime 热重载，改文件即生效。
- **自动纠偏（默认）**：路径未分类时不需要 agent 重试——插件按规范路径把内容写下去，再回执实际落点。
  代写优先走宿主的 `fs` 服务（`fs.resolve` + `fs.writeText`，子目录 recursive 建出、文件策略参与），
  服务缺失才回落 `node:fs`；落点已存在一律不覆盖，`autoCorrect: false` 可切回「打回 + 指引单」。
- **指引单**：打回文本不是一句报错，而是「拦截原因 + 正确路径 + `docs/` 现有结构（含文件数与样例）
  + 可用分类菜单 + 下一步」，让 agent 在被打回的那一刻学会项目的落点约定。
- **内容格式子系统**：按 `.dsh/file-format-specs/<type>/`（`spec.yaml` + `template.md` + `example.md`）
  在 `tools/post-execute` 上校验 `write` / `edit` 命中过的文档；不符时一次报全违规（带行号），
  并附目标模板 / 规则反推的骨架 / 填写参考指针。
- **规则引擎**：文档解析成事实，规则是条件树（`all` / `any` / `not` / `path` / `each` / `exists` /
  `count` / `fn`），支持 `derive` 前向链与 `functions` 自定义函数（`expr` 或 `script`）。
  脚本在 `node:vm` 新上下文里跑，只注入白名单，单次 1 秒超时；脚本抛错只产出一条「函数执行失败」。
- **内置原语**：`frontmatterRequired` / `frontmatterEnum` / `frontmatterPattern` / `sectionsRequired` /
  `sectionsForbidden` / `sectionsServes` / `tableRequired` / `ids` / `idDetails` / `forbiddenText` /
  `requiredText` / `size` / `templateSections`，以及 `hasSection` / `sectionText` / `collectIds` /
  `countIds` / `frontmatter` / `length` / `count` / `matches` / `exists` 等取值助手；解析跳过代码围栏。
- **delta 归责**：`diff_mode: delta` 只把「本次新增的违规」算到这次操作头上，存量文档的历史问题不背锅；
  终止预算由 `max_attempts` / `on_exhausted` 控制。
- **冷启动垫片**：工作区没有规则时回落内置默认继续判定（装完第一单就生效），同时把默认规则落盘成
  可改的草稿；文件一旦存在，内置默认立即让位。`scaffoldDefault: false` 可回到「无规则即放行」。
- **随包资产**：示例路径规则 `examples/md.yaml`，以及五套文档规范 `examples/file-format-specs/`
  （requirement / prd / design / metrics / research），与内置默认**逐字节一致**（`pnpm sync:specs` 生成，测试守护）。
- **Host 服务 `fileEnhance`**：`ensure` / `status` / `provision`，供上层在动手之前按 profile 预置规范；
  `provision` 先校验全部输入再落盘（零字节写入保证），已存在的文件一律跳过、绝不覆写。
  `status` 除生效类型外还给出 `invalid` / `missing`（坏掉的规则或缺规范文件的目录，连同原因）——
  「规则写了却不生效」终于能查，而不是只靠现象猜。
- **结构化日志**：每次内容校验记一条 `spec=… file=… rules=… errors=… warnings=… attempt=n/m`；
  打回走 warn、`warn` 模式 / 仅 warning / 预算用尽放行走 info、未命中任何规范与通过走 debug——
  误报率与命中率可统计，不再只能靠猜。
- **三个开关**：`autoCorrect` / `contentValidate` / `scaffoldDefault`，默认全开。

### 设计取舍

- **零工具面**：工具名 + description + 参数文档是常驻 system prompt 的，注册工具等于把规则面挂上去，
  与「规则不常驻」冲突；问用户用宿主自带的 `ask_user_question`，改规则用原生 `write` 改 yaml。
- **不改写工具入参**：宿主把 `exec.arguments` 深度冻结、`PreToolDecision` 也没有「改参数」一档，
  所以默认由插件代写（方案 A），而不是让 agent 用新路径重试（方案 B）。
- **内容校验发生在落盘之后**：`post-execute` 才拿得到最终全文；`block` 只把工具结果变成错误，不回滚内容。

### 工程

- TypeScript + tsdown 构建（ESM + `.d.mts` 类型），`dist/` 不入库，`prepack` 自动构建。
- vitest：**9 文件 / 159 用例**，含示例规范守护（模板必须通过自己的 spec）与 `docs/` 真实文稿守护。
- GitHub Actions CI：typecheck → test → build → dist 装载冒烟（`pnpm check:dist`）。
- 包元数据、MIT LICENSE、README、插件清单本地化（`locale/zh.json`、`locale/en.json`）。

### 已知边界

见 [README「已知边界」](README.md#已知边界)：只拦 `write` 新建的 `.md`、不管存量文件、不校验规则文件本身、
内容校验晚于落盘、同一目标连拦一次即放行（根目录禁令除外）。
