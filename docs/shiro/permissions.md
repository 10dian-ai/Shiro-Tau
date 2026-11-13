# 权限与策略

每一次工具调用都经过同一条判定流水线，结果是三种之一：**放行**、**询问**、**拒绝**。这里说明流水线怎么走、规则怎么写、配置放在哪里。

想快速看结论，用 `shiro policy check`：

```bash
shiro policy check bash "git push origin main"
shiro policy check edit .git/config --mode acceptEdits
shiro policy check read /etc/hosts --json
```

## 权限模式

| 模式 | 读 | 改文件 | 跑命令 | 其他工具（如 MCP） |
| --- | --- | --- | --- | --- |
| `default` | 放行 | 询问 | 询问 | 询问 |
| `acceptEdits` | 放行 | 放行 | 询问 | 询问 |
| `plan` | 放行 | 拒绝 | 拒绝 | 询问 |
| `dontAsk` | 放行 | 拒绝 | 拒绝 | 拒绝 |
| `bypassPermissions` | 放行 | 放行 | 放行 | 放行 |

补充：

- 只读命令（`ls`、`cat`、`grep`、`git status`、`git diff` 等，且不碰工作区以外的路径）在所有模式下都放行，包括 `plan`。
- `dontAsk` 的含义是"该问的一律拒绝"，适合无人值守的运行；允许规则照常生效。
- `bypassPermissions` 下拒绝规则、被禁止的命令规则和询问规则仍然有效，其余全部放行。只应在一次性的沙箱环境里使用。
- 没有 `auto` 模式（见 [路线图](roadmap.md)）。

切换方式：启动时 `--permission-mode <模式>`，会话中 `/permissions <模式>`，或在配置里写 `defaultMode`。命令行和 `/permissions` 优先于配置文件里的 `defaultMode`；配置文件之间，管理员覆盖项目，项目覆盖用户。管理员想禁止 `bypassPermissions`，用 `disableBypassPermissions`（见下文），它对命令行同样有效。

没有界面可以询问时（`shiro -p`、JSON 模式），"询问"一律变成拒绝，拒绝理由会告诉模型该怎么办。

## 判定顺序

一次调用按下面的顺序判定，先命中的说了算：

1. **拒绝规则。** 命中任何一条 deny 就拒绝。对 shell 命令，一行里任何一条子命令命中都算；文件规则也会对命令里出现的路径和重定向目标生效。
2. **被禁止的命令规则**（`.rules` 文件里 `decision = "forbidden"`）。
3. **`plan` 模式**：改文件、会改东西的命令直接拒绝。
4. **询问规则**、hook 要求询问、命令规则里的 `prompt`：先问。
5. **受保护的路径**：要写入的位置属于受保护路径时先问（`bypassPermissions` 除外）。
6. **工作区边界**：读写工作区以外的文件先问，除非有一条带路径的允许规则覆盖它；重定向到工作区以外、或重定向目标含变量无法事先确定时先问（`bypassPermissions` 除外）。
7. **hook 放行**：PreToolUse hook 说允许，跳过询问。它盖不过前面任何一步。
8. **允许规则和只读命令**：命中就放行。对 shell 命令，一行里的每一条子命令都必须被允许规则、`allow` 命令规则覆盖，或者本身是只读命令。
9. **模式的默认行为**（上表）。

最后，`dontAsk` 模式和没有界面的运行会把"询问"变成"拒绝"。

用户在审批对话框里的选择、每一步的判定依据都会写进工作图，用 `/audit` 查看。

## 规则写法

规则是一个工具名，可以带一个括号里的模式：`工具` 或 `工具(模式)`。

### 工具名

| 写法 | 覆盖的工具 |
| --- | --- |
| `Bash` | `bash` |
| `PowerShell` | `powershell` |
| `Read` | `read`、`grep`、`find`、`ls` |
| `Grep` / `Glob` / `LS` | 分别对应 `grep`、`find`、`ls` |
| `Edit`、`Write`、`MultiEdit` | `edit` 和 `write`（三种写法等价） |
| `mcp__github` | 这个 MCP 服务的全部工具 |
| `mcp__github__create_issue` | 单个 MCP 工具 |
| `mcp__github__get_*` | 工具名里可以用 `*` |

工具名沿用 Claude Code 的写法，所以它的 `settings.json` 可以直接用。

### 命令模式（Bash）

| 模式 | 含义 |
| --- | --- |
| `Bash(npm test:*)` | 以 `npm test` 开头的命令（按词边界，`npm testing` 不算） |
| `Bash(git * main)` | `*` 匹配任意内容 |
| `Bash(npm run lint)` | 不含 `*`：必须完全一致 |

规则按**子命令**匹配。`npm test && rm -rf build` 是两条子命令：`Bash(npm test:*)` 的允许规则只覆盖前一条，所以整行仍然会询问；`Bash(rm -rf:*)` 的拒绝规则命中后一条，整行被拒绝。

拒绝规则和询问规则会看穿包装：`sudo`、`env`、`timeout`、`nice`、`nohup`、`xargs`、`find -exec`、`sh -c "..."`、`eval`、`$(...)` 里的命令都会被拿出来匹配。

解析器跟不上的写法（命令替换、子 shell、heredoc、进程替换、变量当命令名）不会被任何带模式的允许规则放行，只有整工具的 `Bash` 规则能覆盖。PowerShell 命令同理：解析器只认 POSIX shell 语法。

### 路径模式（文件工具）

| 模式 | 含义 |
| --- | --- |
| `Read(.env)` | 不含 `/`：任意目录下叫这个名字的文件 |
| `Edit(/src/**)` | 以 `/` 开头：相对项目目录 |
| `Read(~/.ssh/**)` | 以 `~/` 开头：相对用户主目录 |
| `Read(//etc/hosts)` | 以 `//` 开头：绝对路径 |
| `Edit(docs/*.md)` | 其他：相对当前工作目录 |

`*` 不跨目录，`**` 跨目录，`?` 匹配一个字符。项目目录就是启动 shiro 的目录。

文件规则对 shell 也生效：

- 有 `Read(.env)` 的拒绝规则时，命令的参数里出现 `.env` 这个路径（`cat .env`、`cp .env x`、`--file=.env`）就会被拒绝。
- 有 `Edit(/generated/**)` 的拒绝规则时，重定向到那里（`echo x > generated/a.ts`）会被拒绝；不是只读的命令提到那里的文件（`rm generated/a.ts`、`sed -i … generated/a.ts`）也会被拒绝，只读命令（`cat generated/a.ts`）不受影响。

这个判断是按参数逐个做的，宁严勿松：参数解析出来正好是被拒绝的路径就拒绝，即使它在命令里只是一段文字（比如 `git commit -m ".env"`）。

### 命令规则文件（`.rules`）

Codex 的规则格式，按命令的前几个词匹配：

```python
prefix_rule(
    pattern = ["git", "push", ["--force", "-f"]],   # 列表表示"其中任意一个"
    decision = "forbidden",                          # allow | prompt | forbidden，默认 allow
    justification = "不允许强制推送。",                # 拒绝或询问时显示
    match = ["git push --force origin main"],        # 可选：加载时检查这些例子确实匹配
    not_match = ["git push origin main"],            # 可选：加载时检查这些例子不匹配
)
```

同一条命令命中多条规则时取最严格的一条。目前只支持 `prefix_rule`；文件里的其他语句会被跳过并在 `/permissions` 里提示。

## 配置文件

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 用户 | `~/.shiro/agent/policy.json` | Shiro 自己的格式 |
| 用户 | `~/.claude/settings.json` | 读其中的 `permissions` |
| 用户 | `~/.shiro/agent/rules/*.rules`、`~/.codex/rules/*.rules` | 命令规则 |
| 项目 | `.shiro/policy.json`、`.shiro/policy.local.json` | 后者留给个人，不提交 |
| 项目 | `.claude/settings.json`、`.claude/settings.local.json` | 读其中的 `permissions` |
| 项目 | `.shiro/rules/*.rules`、`.codex/rules/*.rules` | 命令规则 |
| 管理员 | `/etc/shiro-tau/policy.json`（Windows：`%ProgramData%\shiro-tau\policy.json`） | 用户无法覆盖 |

`policy.json` 的字段：

```json
{
  "defaultMode": "acceptEdits",
  "allow": ["Bash(npm test:*)"],
  "ask": ["Bash(git push:*)"],
  "deny": ["Read(.env)"],
  "additionalDirectories": ["../shared-lib", "~/notes"]
}
```

Claude Code 的 `settings.json` 把同样的字段放在 `permissions` 下面，两种写法都认。

合并规则：

- 各层的 `allow`、`ask`、`deny`、命令规则和 `additionalDirectories` 累加。
- `defaultMode` 取最具体的一层：项目覆盖用户，管理员覆盖两者。它只是默认值，命令行和 `/permissions` 可以再切换。
- **项目文件只在项目被信任后才读取。** 第一次打开带有这些文件的项目时，shiro 会先问是否信任这个目录。
- **项目文件不能把模式设成 `bypassPermissions`**，写了会被忽略并提示：一个仓库不应该能替打开它的人关掉审批。
- 管理员文件可以写 `"disableBypassPermissions": true`，之后任何方式都无法进入 `bypassPermissions`。
- 配置有问题（JSON 写错、规则写错、不认识的模式）不会让启动失败：能用的部分照常生效，问题在启动时和 `/permissions` 里列出。

## 受保护的路径

写入下面这些位置永远先问，即使有 `Edit` 的允许规则、即使在 `acceptEdits` 模式下：

- 目录：`.git/`、`.shiro/`、`.pi/`、`.claude/`、`.codex/`
- 文件：`.bashrc`、`.bash_profile`、`.zshrc`、`.zprofile`、`.profile`、`.gitconfig`、`.npmrc`

原因是它们决定了 agent、git 或你的 shell 之后会执行什么。这条规则对文件工具、shell 重定向（`echo x > .git/hooks/pre-commit`）和非只读命令的参数（`cp evil.sh .git/hooks/post-checkout`）都生效。只读访问（`cat .git/HEAD`）不受影响。

这类询问不提供"本次会话不再问"的选项。

## 工作区

工作区是启动 shiro 的目录，加上 `additionalDirectories` 里列出的目录。文件工具读写工作区以外的路径会先问；在询问时选"本次会话不再问"，得到的规则只覆盖那个文件所在的目录。

路径在判定前会解析符号链接，并且按文件工具自己的方式解析（`~`、开头的 `@`、`..`），所以判定的就是工具实际会碰的那个文件。

## 审批对话框

需要询问时，对话框显示调用内容和询问原因，选项是：

- **Yes**：这一次允许。
- **Yes, and do not ask again this session for …**：这一次允许，并在本次会话里加一条允许规则。规则尽量窄：`git commit -m x` 得到的是 `Bash(git commit:*)` 而不是 `Bash(git:*)`；`sudo`、`bash -c` 这类包装命令不提供这个选项。
- **No**（或按 Esc）：拒绝。agent 会停下来等你的指示，而不是换个方式再试。

同一时间只显示一个对话框；排在后面的调用如果已经被前一个回答覆盖，就不会再问。

## 这套机制不保证什么

规则是护栏，不是沙箱。它判断的是 agent **打算做什么**，不能限制一个被允许的程序实际做了什么：允许了 `Bash(python:*)`，这个 python 脚本读写什么文件就不在规则的视野里。需要硬边界时请在容器或虚拟机里运行。操作系统级沙箱在[路线图](roadmap.md)里。
