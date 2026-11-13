# 参与开发

Shiro-Tau 是 [Pi](https://github.com/earendil-works/pi) 的分支。上游的贡献流程（自动关闭 issue、审批名单）不适用于本仓库。

## 环境

需要 Node.js 22.19 或更新版本。

```bash
npm ci --ignore-scripts
npm run build
```

`npm run build` 会从网络获取模型目录。网络不通时用 `npm run build:offline`，它需要 `packages/ai/src/providers/data/` 里已有模型数据（可以从已发布的 `@earendil-works/pi-ai` 包里取）。

## 改代码之前

- 读 [AGENTS.md](AGENTS.md)。它是上游的开发规范，本仓库沿用：只用可擦除的 TypeScript 语法、不用 `any`、一个文件一个概念、每个导出都有一行说明、只在信任边界做运行时校验。
- Shiro 的代码在 `packages/coding-agent/src/shiro/`。`workgraph`、`policy`、`hooks` 三个目录互不依赖，也不引用主干的其他部分；需要组合时放在 `runtime.ts` 这一层。
- 尽量不改上游文件。必须改时，把改动写进 [NOTICE.md](NOTICE.md) 的清单，方便以后合并上游。

## 提交之前

```bash
npm run check                                                     # 格式、lint、依赖检查、类型检查
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/shiro       # Shiro 的测试
node ../../node_modules/vitest/dist/cli.js --run                  # 主干包的全部测试
```

- 每个源文件对应一个测试文件；新功能和修复都要有测试。
- 测试套件以 Pi 的名字运行（见 `packages/coding-agent/vitest.config.ts`），所以上游的测试不用改。检查 `shiro` 这个名字的测试在 `test/shiro/branding.test.ts`。
- 改了行为就同步改 `docs/shiro/` 里的文档和根目录的 `CHANGELOG.md`。
- 提交信息格式：`feat(shiro): …`、`fix(shiro): …`、`docs: …`。

## 合并上游更新

```bash
git remote add upstream https://github.com/earendil-works/pi.git
git fetch upstream
git merge upstream/main
```

冲突应该只出现在 [NOTICE.md](NOTICE.md) 列出的那几个文件里。合并后跑一遍上面的检查和测试。
