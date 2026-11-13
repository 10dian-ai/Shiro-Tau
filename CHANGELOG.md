# 更新记录

这里记录 Shiro-Tau 自己的变化。上游 Pi 的变化见各个包里的 `CHANGELOG.md`。

## [0.1.0] - 2026-11-13

第一个版本。以 Pi 1.5.2（提交 `b4899f5`）为主干。

### 新增

- **权限策略。** 每次工具调用（包括脚本里嵌套发起的调用）在执行前经过同一条判定流水线。五种模式：`default`、`acceptEdits`、`plan`、`dontAsk`、`bypassPermissions`。
- **规则。** `policy.json` 的允许、询问、拒绝规则；兼容 Claude Code `settings.json` 的 `permissions` 和 Codex 的 `.rules` 命令规则。配置分用户、项目、管理员三层。
- **shell 命令解析。** 规则按子命令匹配；拒绝规则看穿 `sudo`、`xargs`、`sh -c`、命令替换等包装；文件规则对命令里出现的路径和重定向目标同样生效。
- **受保护的路径和工作区边界。** 写入 `.git/`、agent 配置目录、shell 启动文件永远先问；工作区以外的读写先问；判定前解析符号链接。
- **审批对话框。** 允许一次、本次会话不再询问（给出尽量窄的规则）、拒绝；拒绝后 agent 停下等待指示。
- **Hooks。** `PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`、`SessionStart`、`SessionEnd` 六个事件的 command hook，兼容 Claude Code 和 Codex 的配置格式、输入字段和输出约定。项目 hook 按内容哈希审查后才运行。
- **工作图。** 每个会话一份只追加的事件日志，记录提示、工具调用、权限判定、hook 运行和文件变更；文件内容按哈希存快照。
- **检查点与回退。** 每次提示自动打检查点；`/rewind` 把文件和对话一起退回，处理记录之外的改动造成的冲突，并提示无法撤销的操作。
- **命令。** `/permissions`、`/hooks`、`/checkpoint`、`/rewind`、`/audit`；命令行的 `shiro policy show`、`shiro policy check` 和 `--permission-mode`。

### 相对上游的变化

- 命令名是 `shiro`，配置目录是 `~/.shiro/agent` 和项目里的 `.shiro/`，与 Pi 互不影响。
- `--version` 显示 Shiro-Tau 自己的版本和所基于的 Pi 版本。
- 项目里有权限规则或 hooks 文件时，打开它需要先做信任决定。
- 没有界面可以询问时（`-p`、JSON 模式），需要审批的调用会被拒绝。上游在这些模式下不做任何限制。
- 不再显示来自 Pi 发布渠道的更新提示。

### 已知限制

见 [README](README.md#已知限制)。
