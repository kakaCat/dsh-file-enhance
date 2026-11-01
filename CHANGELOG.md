# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

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
- **三个开关**：`autoCorrect` / `contentValidate` / `scaffoldDefault`，默认全开。

### 设计取舍

- **零工具面**：工具名 + description + 参数文档是常驻 system prompt 的，注册工具等于把规则面挂上去，
  与「规则不常驻」冲突；问用户用宿主自带的 `ask_user_question`，改规则用原生 `write` 改 yaml。
- **不改写工具入参**：宿主把 `exec.arguments` 深度冻结、`PreToolDecision` 也没有「改参数」一档，
  所以默认由插件代写（方案 A），而不是让 agent 用新路径重试（方案 B）。
- **内容校验发生在落盘之后**：`post-execute` 才拿得到最终全文；`block` 只把工具结果变成错误，不回滚内容。

### 工程

- TypeScript + tsdown 构建（ESM + `.d.mts` 类型），`dist/` 不入库，`prepack` 自动构建。
- vitest：**9 文件 / 145 用例**，含示例规范守护（模板必须通过自己的 spec）与 `docs/` 真实文稿守护。
- GitHub Actions CI：typecheck → test → build → dist 装载冒烟（`pnpm check:dist`）。
- 包元数据、MIT LICENSE、README、插件清单本地化（`locale/zh.json`、`locale/en.json`）。

### 已知边界

见 [README「已知边界」](README.md#已知边界)：只拦 `write` 新建的 `.md`、不管存量文件、不校验规则文件本身、
内容校验晚于落盘、同一目标连拦一次即放行（根目录禁令除外）。
