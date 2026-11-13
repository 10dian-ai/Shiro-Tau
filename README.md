# Shiro-Tau

Shiro-Tau 是一个以 [Pi](https://github.com/earendil-works/pi) 为主体的编程工具。它不是在 Pi 外面套一层扩展包，而是在 Pi 的主干里长出三样 Pi 没有的东西：一套所有工具调用都要经过的**信任系统**、一个记录"谁在什么时候改了什么"的**工作图**、以及能直接读 Claude Code 和 Codex 配置的 **hooks 层**。

> English: Shiro-Tau is a coding agent built on a fork of Pi. This first version adds a permission system every tool call passes through, a work graph with checkpoints and rewind, and lifecycle hooks that read Claude Code and Codex configuration. Documentation is in Chinese; code and comments are in English.

**当前版本：0.1.0**，基于 Pi 1.5.2（提交 `b4899f5`）。这一版完成了阶段 1（地基）里的工作图、策略引擎和 hooks，并且测过。阶段 1 剩下的沙箱、宿主进程和桌面端，以及后面的多 agent、浏览器、远程都还没有做，见[路线图](docs/shiro/roadmap.md)。

## 这一版能做什么

### 一套信任系统

Pi 本身没有权限控制：模型想跑什么命令就跑什么。Shiro-Tau 里，每一次工具调用（读文件、改文件、跑命令、MCP 工具，包括脚本里嵌套发起的调用）都先过同一条判定流水线，再决定放行、询问还是拒绝。

- **五种权限模式**：`default`（读直接放行，改和跑命令先问）、`acceptEdits`（工作区内的修改也放行）、`plan`（只读）、`dontAsk`（该问的一律拒绝，适合无人值守）、`bypassPermissions`（除了被拒绝的都放行，只应在一次性沙箱里用）。
- **三种规则写法都认**：Shiro 自己的 `policy.json`、Claude Code 的 `settings.json`（`permissions.allow/ask/deny`）、Codex 的 `.rules` 文件（`prefix_rule(...)`）。已有的配置不用重写。
- **拒绝规则永远优先**：钩子说放行、模式是 bypass，都盖不过一条 deny。
- **文件规则对 shell 同样生效**：写了 `Read(.env)` 的拒绝规则，`cat .env`、`cp .env /tmp/x`、`bash -c 'cat .env'` 都会被拦下，不只是读文件工具。
- **看得穿包装**：`sudo rm -rf`、`timeout 5 rm -rf`、`xargs rm -rf`、`sh -c "rm -rf"`、`$(rm -rf)` 都按 `rm -rf` 判定。
- **受保护的路径**：改 `.git/`、`.shiro/`、`.claude/`、`.codex/` 和 shell 启动文件（如 `~/.bashrc`）永远先问，即使在 `acceptEdits` 模式下，即使是通过重定向（`echo x > .git/hooks/pre-commit`）。
- **工作区边界**：工作目录以外的读写先问；路径先解析符号链接，工作区里的软链接不能当作出口。
- **审批对话框**：显示要做什么、为什么要问，可以"这次允许"、"本次会话不再问（给出一条尽量窄的规则）"或"拒绝"。拒绝后 agent 停下来等你的指示。

详见 [docs/shiro/permissions.md](docs/shiro/permissions.md)。

### Hooks

在提交提示、工具调用前后、agent 准备停下、会话开始和结束这六个时机运行你自己的命令。配置格式和 Claude Code、Codex 相同，三处的配置都会读：`hooks.json`、`~/.claude/settings.json` 的 `hooks`、`~/.codex/hooks.json`。

- `PreToolUse` 可以拒绝调用、回答权限问题、改写工具输入；`PostToolUse` 可以把 lint 失败之类的反馈交给模型；`Stop` 可以说"还没做完"让 agent 继续；`UserPromptSubmit` 可以拦下提示或附加上下文。
- 项目自带的 hook 必须先审查（`/hooks trust`）才会运行；命令内容变了要重新审查。
- 退出码 2 表示阻止，其他非零退出码和超时不会阻止调用。

详见 [docs/shiro/hooks.md](docs/shiro/hooks.md)。

### 工作图与回退

每个会话有一份只追加的事件日志：提示、工具调用、每一次权限判定（谁决定的、依据哪条规则）、hook 运行、文件变更（内容按哈希存快照）。

- 每次提示自动打一个检查点，也可以用 `/checkpoint` 手动打。
- `/rewind` 把文件和对话一起退回某个检查点。可以只退文件或只退对话。
- 回退前会列出要恢复、要删除的文件；在记录之外被改过的文件会单独问你要不要覆盖。
- shell 命令造成的改动无法撤销，回退前会列出来提醒。
- `/audit` 查看最近的权限判定和本次会话改过的文件。

详见 [docs/shiro/work-graph.md](docs/shiro/work-graph.md)。

### 不启动会话也能检查策略

```bash
shiro policy show                                  # 当前目录生效的模式、规则、读了哪些文件、有什么问题
shiro policy check bash "git push --force"         # 这条命令会被放行、询问还是拒绝，为什么
shiro policy check edit src/index.ts --mode plan
```

## 安装与运行

需要 Node.js 22.19 或更新版本。目前只能从源码构建。

```bash
git clone <本仓库地址> shiro-tau
cd shiro-tau
npm ci --ignore-scripts
npm run build
mkdir -p ~/.local/bin
ln -sf "$PWD/packages/coding-agent/dist/bundle/cli.js" ~/.local/bin/shiro   # 确保 ~/.local/bin 在 PATH 里
```

Windows 上直接用 `node <仓库路径>\packages\coding-agent\dist\bundle\cli.js` 运行，或者给它建一个别名。

不要用 `npm link` 或 `npm install -g` 安装：这个包目前和 Pi 同名，会把已经装好的 Pi 覆盖掉。

然后在你的项目目录里运行：

```bash
cd /path/to/project
shiro                                   # 交互界面
shiro --permission-mode acceptEdits     # 指定权限模式启动
shiro -p "跑一下测试并修复失败的用例"     # 一次性执行；没人可问时，需要审批的调用会被拒绝
```

模型接入沿用 Pi 的方式：在界面里用 `/login` 登录内置的服务商，或者在 `~/.shiro/agent/models.json` 里配置 OpenAI、Anthropic、Google 兼容的端点（自建网关也是这样接）：

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://gateway.example.com/v1",
      "api": "openai-completions",
      "apiKey": "sk-...",
      "models": [{ "id": "your-model-id" }]
    }
  }
}
```

配置目录是 `~/.shiro/agent/`，项目级配置在项目的 `.shiro/` 下，和 Pi 的 `~/.pi/` 互不影响。

## 配置示例

`~/.shiro/agent/policy.json`（或项目里的 `.shiro/policy.json`）：

```json
{
  "defaultMode": "acceptEdits",
  "allow": ["Bash(npm test:*)", "Bash(git commit:*)", "Read(//opt/sdk/**)"],
  "ask": ["Bash(git push:*)"],
  "deny": ["Read(.env)", "Read(~/.ssh/**)", "Bash(rm -rf:*)"],
  "additionalDirectories": ["../shared-lib"]
}
```

`~/.shiro/agent/rules/team.rules`（Codex 的规则格式）：

```python
prefix_rule(
    pattern = ["git", "push", ["--force", "-f"]],
    decision = "forbidden",
    justification = "不允许强制推送。",
)
```

`~/.shiro/agent/hooks.json`：

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx biome check --write \"$SHIRO_PROJECT_DIR\"" }] }
    ]
  }
}
```

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `/permissions` | 显示当前模式、规则、读取的配置文件和问题 |
| `/permissions <模式>` | 切换权限模式 |
| `/hooks` | 列出 hooks 及其状态 |
| `/hooks trust` | 逐个审查项目自带的 hook |
| `/checkpoint [名称]` | 手动打一个检查点 |
| `/rewind [编号]` | 回退到检查点 |
| `/audit [数量]` | 最近的权限判定和本次会话改过的文件 |
| `shiro policy show` / `check` | 在会话之外查看和测试策略 |
| `--permission-mode <模式>` | 启动时指定权限模式 |

Pi 原有的命令（`/model`、`/tree`、`/compact`、`/resume` 等）和功能（扩展、技能、MCP、RPC、SDK）都保留，见 [packages/coding-agent/docs](packages/coding-agent/docs)。

## 代码在哪里

Shiro 的代码在主干包里，不是外挂的扩展包；`--no-extensions` 关不掉它。

```
packages/coding-agent/src/shiro/
  workgraph/   工作图：事件日志、内容快照、文件历史、回退、投影
  policy/      策略引擎：shell 解析、规则、只读判定、判定流水线、配置加载
  hooks/       hooks：配置加载、审查记录、命令运行、结果汇总
  runtime.ts   接进 agent 循环：每次工具调用依次经过 hooks、策略引擎、审批
  approval.ts  审批：问策略引擎，需要时问人
  commands.ts  /permissions /hooks /checkpoint /rewind /audit
  session.ts   每个会话的状态
  policy-command.ts   shiro policy 命令
packages/coding-agent/test/shiro/   对应的测试
docs/shiro/                         文档
```

`workgraph`、`policy`、`hooks` 三个目录互不依赖，也不依赖主干的其他部分，只由 `runtime.ts` 组合起来。相对上游 Pi，除了新增的目录，只改动了少数几个文件（入口、项目信任判定、帮助文本、版本显示和包配置），方便以后合并上游更新。

## 验证

```bash
npm run check                                    # 格式、lint、依赖和类型检查
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/shiro    # Shiro 的测试
```

## 已知限制

- **规则是护栏，不是沙箱。** 被允许的命令（比如你允许了 `python`）能做的事不受规则约束。操作系统级的沙箱在路线图里，还没有做。
- **回退只覆盖文件工具的改动。** shell 命令创建或修改的文件不在快照里，回退时只会提醒。
- **没有 `auto` 模式。** 由模型判断风险的自动审批需要守护模型，属于后续阶段。配置里写了 `auto` 会被忽略并提示。
- **hooks 只支持 `command` 类型**，事件只有上面六个。其他类型和事件会被跳过并提示。
- **界面里还有一些 Pi 的痕迹**：启动画面的图标、`/bug` 和 `/share`（指向 Pi 的服务）、`shiro update self`（Shiro 不通过 Pi 的发布渠道更新，请用 `git pull` 后重新构建）。
- **包名仍是 `@earendil-works/pi-*`**，没有发布到 npm，所以只能按上面的方式从源码运行。
- **上游的打包和发布脚本还没有适配**：Nix 包、独立二进制、安装脚本、npm 发布流程仍然按 `pi` 这个名字写的，不要用它们来打包 Shiro-Tau。
- 旧会话的工作日志目前不会自动清理，位于 `~/.shiro/agent/workgraph/`。

## 与 Pi 的关系

Shiro-Tau 是 Pi 的分支（fork），Pi 由 Mario Zechner 和 Earendil 团队开发，以 MIT 许可证发布。本仓库保留了上游的许可证和版权声明，见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。Shiro-Tau 不是 Pi 的官方版本，与 Earendil 没有从属关系；Shiro-Tau 的问题请在本仓库反馈，不要提交给上游。

Claude Code 和 Codex 的配置格式是根据它们的公开文档独立实现的，没有使用它们的源代码。

## 许可证

MIT，见 [LICENSE](LICENSE)。
