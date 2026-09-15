# dsh-github-ops

DeepSeek Harness 插件：**建仓、推文件、开 PR、发 release 并上传附件**。

对标 opencode 的 GitHub MCP —— 一次配好凭据长期可用，模型在对话里直接调用 `github_*` 工具完成 GitHub 事务。

- **零依赖**：只用 Node 内置模块。ZIP 打包自实现（含 CRC-32），HTTP 走内置 `fetch`，不装任何 npm 包。
- **不走 `git` 二进制**：全部走 REST API v3。本地 `git push` 需要凭据助手或交互式输入，非交互式 harness 两样都没有；Git Data API 用同样的语义完成提交且不需要它们。
- **凭据是引用不是明文**：配置里只有 `GITHUB_TOKEN` 这个引用名，值每次操作现取，换 token 不用重启，不进日志、不进工具输出。
- **版本一致性硬拦**：tag / `package.json` / 附件名三者不一致时拒绝发布。

---

## 工具清单

| 工具 | 作用 | 审批 |
|---|---|---|
| `github_auth_status` | 报告凭据是否可用、属于哪个账号、剩余配额。**永不返回 token 本身** | ✅ 免审批 |
| `github_create_repository` | 建仓，可选 topics / 简介 / 可见性 | ✅ 免审批 |
| `github_push_files` | 一次提交写入多个文件（`blob → tree → commit → ref`），分支不存在则自动创建 | ✅ 免审批 |
| `github_upload_project` | 一句话上传本地项目目录：可选建仓 → 提交整棵树 → 可选开 PR | ✅ 免审批 |
| `github_release_publish` | 发 release 并挂附件。能从源码代打包，自带版本校验与正文模板 | ✅ 免审批 |
| `github_get_release` | 读已有 release：正文、附件名/大小/下载量、草稿状态 | ✅ 免审批 |

**只有破坏性操作才弹审批**，且一次授权只对一次调用有效：

| 触发 | 工具与参数 |
|---|---|
| force push | `github_push_files` / `github_upload_project` 的 `force: true` |
| 删 tag 重建 | `github_release_publish` 的 `deleteExistingTag: true` |

审批机制是 `tools/pre-execute` waterfall，返回 `{ kind: 'ask' }` 后由 harness 的审批服务裁决。**没有审批通道时 `ask` 自动降级为拒绝**（fail closed），不会静默放行。

---

## 安装

### 1. 放到一个稳定位置

插件会被 profile 长期引用，所以放在你不会随手删掉的地方。删掉或移动它，profile 下次启动就会失败。

### 2. 在 profile 的 patch 层注册

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`（通常是 `~/.dsh/profiles/web/cordis.patch.yml`），在顶层数组里追加：

```yaml
- insert:
    - id: github-ops
      name: /绝对路径/dsh-github-ops/index.js
      config:
        tokenRef: GITHUB_TOKEN
        defaultOwner: Reduction77
```

> ⚠️ **`name` 必须是绝对路径（或 `file://` URL），不能用裸包名。**
>
> 这是实测结论，不是保守写法：把包放进 profile 的 `node_modules`（包括用 `dsh plugin --profile web add "link:/path"` 让 pnpm 建好链接）再用 `name: dsh-github-ops`，`dsh --dump-config` 会正常输出、依赖也确实链接成功，但**启动时炸**：
>
> ```
> Error: failed to import loader entry github-ops (dsh-github-ops):
> Cannot find package 'dsh-github-ops' imported from
> .../@deepseek-ai/cordis-plugin-loader/lib/index.js
> ```
>
> 原因是 cordis loader 从**它自己在 harness checkout 里的位置**发起 import，Node 的解析向上遍历永远到不了 profile 目录。内置插件能用裸名是因为它们本来就在 harness 的 `node_modules` 里。
>
> 顺带一提：`dsh plugin add` 建的 `link:` 依赖对**第三方插件不可用**，而且 pnpm 会把它写成相对链接（如 `../../../../dsh-github-ops`），一旦插件目录移动就悬空。所以直接写绝对路径最省事。

如果你的环境有 `DSH_HOME` 之外的 profile 别名，把上面的 `web` 换成对应名字即可。

### 3. 配置凭据

DSH 里打开 **设置 → 插件 → 凭据 → 新增**：

- 键名：`GITHUB_TOKEN`
- 值：你的 Personal Access Token

Token 权限建议：

| scope | 用途 |
|---|---|
| `repo` | **必需**。公开与私有仓库的完整读写、建仓、发 release |
| `workflow` | 要改 `.github/workflows/*` 才需要，否则推这类文件会被 GitHub 直接拒 |
| `delete_repo` | 只有要删仓库才需要 |

也可以走环境变量（provider 的解析顺序是 env → 凭据存储 → `.env` 回退），但设置页更省事且不用重启。

### 4. 重启 dsh web

```sh
dsh web
```

### 5. 验证

对话里说「用 github_auth_status 看看凭据状态」。返回 `valid: true` 加你的账号名就通了。

排查工具没出现时，在 config 里加 `statusFile`，插件启动时会把工具清单写到那个文件：

```yaml
        statusFile: /tmp/dsh-github-ops-status.json
```

---

## 用法示例

### 发一个插件版本（最常用）

对话里直接说：

> 把 `v1.7.0` 发到 `Reduction77/napcat-plugin-bili-recognizer`，目录在当前工作区

模型会调用：

```
github_release_publish(tag: "v1.7.0", repo: "napcat-plugin-bili-recognizer", dir: "/path/to/project")
```

它会依次做：

1. **解析附件** —— 按顺序尝试：显式 `assetPath` → `dist/<包名>-<版本>.zip` → 项目的 `pack:plugin`/`package` 脚本 → 内置 ZIP 打包
2. **版本一致性校验** —— tag、`package.json` 的 `version`、附件名里的版本三者必须一致
3. **建 tag**（不存在时）
4. **组装正文** —— 抓 `CHANGELOG.md` 里对应版本的小节，拼上标准安装段
5. **建或更新 release**
6. **流式上传附件** —— 同名附件自动先删后传

结果里会告诉你是新建还是更新、替换了哪个旧附件、附件由什么产出。

### 上传一个项目

```
github_upload_project(repo: "my-tool", dir: "/path/to/project", createPullRequest: true)
```

自动排除 `node_modules`、`.git`、`dist`、`config`、`data`、`downloads`、`__pycache__` 等目录 —— 不排的话一个 `dist/` 就能把仓库撑到几百 MB。

### 只用文件推送

```
github_push_files(
  repo: "my-tool",
  branch: "feature/x",
  message: "feat: 新增导出",
  files: [
    { path: "src/a.mjs", localPath: "/abs/path/src/a.mjs" },
    { path: "README.md", content: "# 标题" }
  ]
)
```

二进制文件也走这条路（内容按 base64 传 blob），PNG 和 exe 都能原样到达。

---

## 版本一致性校验

`checkVersionConsistency` 比对三处版本：**tag**、**`package.json` 的 `version`**、**附件文件名里的版本**。

不一致时默认**拒绝发布**并逐条列出差异：

```
版本一致性校验未通过，已拒绝发布：
- tag 是 `2.0.0`，但 package.json 里是 `1.6.0`
- tag 是 `2.0.0`，但附件名里的版本是 `0.3.0`
- 附件名 `demo_v0.3.0_GitHub_Source.zip` 里出现了多个版本号，容易让人误判
```

这条规则来自一个真实案例：`Reduction77/UniversalConverter` 的 tag 是 `v1.0.0`，附件却叫 `UniversalConverter_v0.3.0_GitHub_Source.zip`。GitHub 不会阻止这种发布，而下载的人无从分辨。

确认无误要强行发布，显式传 `forceVersion: true`，结果里会标注"已用 forceVersion 跳过"及具体差异。

---

## 附件与打包

### 自动解析顺序

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `assetPath` | 你明确给的路径 |
| 2 | `dist/<包名>-<版本>.zip` | 项目自己的打包产物，命中就不重新打包 |
| 3 | `package.json` 的 `pack:plugin` 或 `package` 脚本 | shell-free 执行（按空白切分后 `spawn`，不走 shell） |
| 4 | 内置 ZIP 打包 | 项目没有任何打包脚本时的兜底 |

脚本跑成功但产物名不对时，会明确报出来而不是拿错文件上传 —— 这种情况在 `pack:plugin` 改过输出名之后很容易发生。

### 内置打包的文件选择

- 根文件：`package.json`、`index.mjs`、`index.js`、`README.md`、`LICENSE`、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`
- 根目录：`lib`、`src`、`webui`、`assets`、`docs`、`tools`、`scripts`
- 后缀白名单：`.mjs .cjs .js .ts .css .html .md .json .txt .png .jpg .jpeg .webp .gif .svg .yml .yaml .py .sh`
- 符号链接**不解引用**（一个指向项目外的链接会把无关内容带进发布产物）

### 大文件

- 附件上传走 `openAsBlob` **流式读取**，不整个读进内存。68 MB 的 exe 没问题。
- 上传超时独立于普通请求（默认 10 分钟，`uploadTimeoutMs` 可调），因为默认 30 秒对几十 MB 的文件必然不够。
- 显式设置 `Content-Length`：不设的话 fetch 会用 chunked 编码，GitHub 的上传端点直接拒。
- 附件走 `uploads.github.com`（**不是** `api.github.com`），这是 GitHub 返回的 `upload_url` 模板里的 host。
- **附件不进 git 历史** —— 仓库体积零增长。这对 195 MB 的仓库是刚需。
- GitHub 单附件上限 **2 GB**。

### release 正文

默认从 `CHANGELOG.md` 抽取对应版本的小节，拼成：

```markdown
## v1.6.0

<CHANGELOG 里 1.6.0 那一节的内容>

### 下载

- `napcat-plugin-bili-recognizer-1.6.0.zip`

### 安装

安装步骤见仓库 README 的 **安装** 一节；下载上面的附件，不要使用 GitHub 自动生成的
Source code 压缩包（它带一层仓库目录，与安装包结构不同）。
```

安装段是**指针而非副本** —— README 的安装步骤带具体文件名和版本号，复制一份到正文里就等于多了一个忘改的地方。

传 `body` 整段覆盖；`notesFromChangelog: false` 关掉自动抽取。

---

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `tokenRef` | `GITHUB_TOKEN` | 凭据引用名 |
| `apiBase` | `https://api.github.com` | REST 基地址，GitHub Enterprise 需改 |
| `timeoutMs` | `30000` | 普通请求超时 |
| `uploadTimeoutMs` | `600000` | 附件上传超时 |
| `packTimeoutMs` | `180000` | 打包脚本超时 |
| `defaultOwner` | `''` | 省略 `owner` 时用谁；留空则查询当前认证用户 |
| `statusFile` | `''` | 启动时写状态卡片的路径，留空不写 |

---

## 已知限制

- **不能删仓库、删分支、删文件、改可见性、合并 PR。** 这些是刻意不做的：本插件的定位是发布链路，而删除类操作应该走 GitHub 网页或 `gh`，那里有更完整的确认与审计。审批门目前只为 force push 和 tag 重建而设。
- **不能改仓库设置**（描述、topics 之外的部分）。建的仓能带 topics，改已有的不行。
- **不发 Discussion、不碰 Issues。**
- **私有仓库需要 `repo` scope**，否则 `github_auth_status` 会报 `valid: false` 或操作返回 404。
- 附件上传**同步等待**完成。68 MB 大约几十秒，取决于上行带宽。

---

## 开发

```sh
npm run verify     # preflight（依赖链接 + schema 校验）+ 全部单测
npm test           # 只跑单测
npm run preflight  # 只跑 preflight
```

`preflight` 做三件事：从 `which dsh` 反查 harness checkout 并把 peer 依赖链接进来、确认 `apply()` 注册的工具集合与 `REGISTERED_TOOL_NAMES` 一致、用 harness 自己的 `assertObjectJsonSchema` / `assertSupportedJsonSchema` 校验编译后的线协议 schema。

测试不依赖网络与真实 token：

- `test/zip.test.mjs` —— 手写 ZIP 的正确性由 **Python `zipfile`** 独立读取并逐项校验 CRC 来证明，而不是用自己的代码验自己。
- `test/github-ops.test.mjs` —— 用假 `fetch` 按 GitHub API 语义应答，跑通建仓 → 推文件 → 开 PR → 发 release → 传附件的完整流程，并断言请求序列、审批门行为、以及校验失败时**零写入**。

---

## 目录结构

```
index.js                  插件入口：Config、6 个工具定义、审批钩子、启动标记
lib/gh-http.js            REST 客户端、流式上传、凭据解析与脱敏
lib/gh-zip.js             零依赖 ZIP 打包（自实现 CRC-32 兜底）
lib/gh-release.js         版本规范化、一致性校验、CHANGELOG 抽取、正文模板
lib/gh-approval.js        破坏性操作分类
cordis.patch.yml          bundle patch 层模板
scripts/preflight.mjs     装载契约与 schema 校验
scripts/probe-api.mjs     假 GitHub API，供端到端探针使用
test/                     单测
```

## 许可

MIT
