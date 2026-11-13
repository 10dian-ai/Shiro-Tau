# Hooks

Hook 是你自己写的命令，shiro 在固定的时机运行它，把当时的情况用 JSON 从标准输入交给它，再根据它的退出码和输出决定下一步。配置格式与 Claude Code、Codex 相同，为它们写的 command hook 可以直接用。

## 六个时机

| 事件 | 什么时候 | hook 能做什么 |
| --- | --- | --- |
| `SessionStart` | 会话开始或恢复 | 输出的文字作为上下文交给模型 |
| `UserPromptSubmit` | 你提交提示时，模型看到之前 | 拦下这条提示；或附加上下文 |
| `PreToolUse` | 工具运行前，权限判定之前 | 拒绝调用；回答权限问题（允许或要求询问）；改写工具输入；附加上下文 |
| `PostToolUse` | 工具运行后 | 把问题反馈给模型（比如 lint 失败）；附加上下文 |
| `Stop` | agent 准备停下时 | 说"还没做完"，让它带着你给的理由继续 |
| `SessionEnd` | 会话结束 | 只能旁观，比如做清理或记录 |

其他事件（如 `PreCompact`、`SubagentStop`）这一版不会运行，配置里写了会被跳过并在启动时提示。

## 配置

所有文件用同一种结构：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "~/.shiro/agent/hooks/guard.sh", "timeout": 10 }]
      }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npm run lint --silent" }] }
    ]
  }
}
```

读取的位置：

| 层 | 文件 |
| --- | --- |
| 管理员 | `/etc/shiro-tau/hooks.json`（Windows：`%ProgramData%\shiro-tau\hooks.json`） |
| 用户 | `~/.shiro/agent/hooks.json`、`~/.claude/settings.json`（其中的 `hooks`）、`~/.codex/hooks.json` |
| 项目 | `.shiro/hooks.json`、`.claude/settings.json`、`.claude/settings.local.json`、`.codex/hooks.json` |

说明：

- `matcher` 是正则表达式，要求匹配**整个**名字。对工具事件，它匹配工具名：既可以写 Claude Code 的名字（`Bash`、`Read`、`Write`、`Edit`、`Grep`、`Glob`、`LS`），也可以写 shiro 自己的名字（`bash`、`read` …），MCP 工具是 `mcp__服务__工具`。对 `SessionStart`，它匹配来源：`startup`、`resume`、`clear`；对 `SessionEnd`，它匹配原因：`exit`、`clear`、`resume`、`other`。省略、空字符串或 `*` 表示全部匹配。
- `timeout` 的单位是秒，默认 60。超时的 hook 会被终止（在 Linux 和 macOS 上连同它启动的子进程一起）。
- 只支持 `"type": "command"`。其他类型（`prompt`、`agent`、`http`）会被跳过并提示。
- 同一事件下匹配的多个 hook **同时**运行。同一条命令重复登记只运行一次。
- 命令通过系统 shell 执行，工作目录是项目目录，环境变量里有 `SHIRO_PROJECT_DIR` 和 `CLAUDE_PROJECT_DIR`（都指向项目目录）。

## 输入

hook 从标准输入读到一个 JSON 对象。所有事件都有：

```json
{
  "session_id": "…",
  "transcript_path": "/…/session.jsonl",
  "cwd": "/path/to/project",
  "hook_event_name": "PreToolUse",
  "permission_mode": "default"
}
```

各事件另外带：

| 事件 | 字段 |
| --- | --- |
| `PreToolUse` | `tool_name`、`tool_use_id`、`tool_input` |
| `PostToolUse` | 同上，加 `tool_response`（`{ "text": "…", "is_error": false }`） |
| `UserPromptSubmit` | `prompt` |
| `Stop` | `stop_hook_active`（这次停止是不是已经由 Stop hook 续过） |
| `SessionStart` | `source` |
| `SessionEnd` | `reason` |

`tool_name` 用的是 Claude Code 的名字。`tool_input` 是工具自己的字段，另外补上 hook 习惯读的字段：有 `path` 的工具同时给出 `file_path`；只做一处替换的 `edit` 调用同时给出 `old_string` 和 `new_string`。

## 输出

### 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功。标准输出如果是一个 JSON 对象，按下面的字段解释；否则当作普通文字 |
| 2 | **阻止**。标准错误的内容是理由 |
| 其他 | 出错。不阻止任何事情，只记录 |

超时和启动失败同样不阻止。也就是说，一个坏掉的 hook 不会让 agent 卡住，但也**不会**起到拦截作用。

### JSON 字段

| 写法 | 适用事件 | 效果 |
| --- | --- | --- |
| `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "…"}}` | PreToolUse | 拒绝调用 |
| `{"hookSpecificOutput": {"permissionDecision": "allow"}}` | PreToolUse | 跳过审批询问 |
| `{"hookSpecificOutput": {"permissionDecision": "ask"}}` | PreToolUse | 要求询问用户 |
| `{"hookSpecificOutput": {"updatedInput": {…}}}` | PreToolUse | 改写工具输入，没写的字段保持原值 |
| `{"hookSpecificOutput": {"additionalContext": "…"}}` | SessionStart、UserPromptSubmit、PreToolUse、PostToolUse | 附加给模型的上下文 |
| `{"decision": "block", "reason": "…"}` | PreToolUse、PostToolUse、UserPromptSubmit、Stop | 阻止（旧写法，仍然支持） |
| `{"decision": "approve"}` | PreToolUse | 同 `permissionDecision: "allow"`（旧写法） |
| `{"continue": false, "stopReason": "…"}` | 同 `block` | 阻止 |

各事件里"阻止"的含义：

- **PreToolUse**：这次调用不执行，理由交给模型。
- **PostToolUse**：工具已经运行过，无法撤销；理由追加在工具结果后面交给模型。
- **UserPromptSubmit**：这条提示不发给模型，理由显示给你。
- **Stop**：agent 不停下，带着理由继续工作。为了防止死循环，最多连续这样续 5 次，之后放它停下并提示。

`SessionStart` 和 `UserPromptSubmit` 的普通文字输出会作为上下文交给模型。

### 多个 hook 的结果怎么合并

- 只要有一个 hook 拒绝，调用就被拒绝，不管其他 hook 说什么。
- `ask` 压过 `allow`。
- 多个 hook 都改写输入时，按配置里的顺序依次应用，同一个字段以后面的为准。

## hook 与权限判定的关系

PreToolUse hook 在权限判定之前运行，它的回答是判定的一个输入，不是最终结论：

- hook 的**拒绝**是最终的。
- hook 的**允许**只是跳过询问。拒绝规则、被禁止的命令、`plan` 模式、受保护路径和工作区边界仍然照常生效。
- hook 改写后的输入才是被判定和执行的输入。

所以 hook 只能让事情更严，或者省掉一次本来会问的询问，不能绕开一条拒绝规则。

## 项目 hook 要先审查

来自用户自己目录和管理员目录的 hook 直接运行。**项目目录里的 hook 来自仓库，默认不运行**：启动时会提示有几个 hook 等待审查，用 `/hooks trust` 逐个查看完整命令并决定是否信任。

信任是按内容记的（事件、matcher 和命令一起算哈希），记录在 `~/.shiro/agent/hook-trust.json`。命令改了一个字符就是一个新的 hook，需要重新审查。这样 `git pull` 带进来的改动不会悄悄执行。

未审查的 hook 被跳过时会记进工作图（状态为 `untrusted`）。注意这意味着：一个用来做安全拦截的项目 hook，在审查之前**不起作用**。

`/hooks` 列出所有 hook、来源文件和状态。

## 一个完整的例子

阻止 agent 直接改锁文件，并在每次改完代码后跑格式化：

`~/.shiro/agent/hooks/protect-lockfile.sh`

```bash
#!/usr/bin/env bash
path=$(jq -r '.tool_input.file_path // empty')
case "$path" in
  *package-lock.json|*pnpm-lock.yaml)
    echo "锁文件由包管理器生成，不要手动修改。请运行安装命令。" >&2
    exit 2 ;;
esac
```

`~/.shiro/agent/hooks.json`

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "~/.shiro/agent/hooks/protect-lockfile.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx biome format --write . >/dev/null" }] }
    ]
  }
}
```
