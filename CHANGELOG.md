# 更新日志

## 0.1.0

- 首个版本。6 个模型工具：`github_auth_status`、`github_create_repository`、`github_push_files`、
  `github_upload_project`、`github_release_publish`、`github_get_release`。
- 凭据走 DSH 凭据引用（`GITHUB_TOKEN`），每次操作现取，不缓存、不落日志、不出现在工具输出里。
- 发布链路内置版本一致性校验：tag / `package.json` 版本 / 附件文件名三者必须一致，不一致默认硬拦。
- release body 默认从 `CHANGELOG.md` 抽取对应版本小节，拼装标准安装段，可用 `body` 整段覆盖。
- 附件上传走流式读取（`createReadStream`），大文件不占内存；单附件超时独立可配（默认 10 分钟）。
- 零 npm 依赖：只用 Node 内置模块，ZIP 打包自实现（含 CRC-32）。
- 破坏性操作（删库／删分支／删 release／force push／改可见性）走 `tools/pre-execute` 审批门，
  缺审批通道时 fail closed。
