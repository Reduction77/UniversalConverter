# GitHub 上传与发布指南

本包是源码包，不包含 node_modules、Electron 运行库或转换引擎。不会自动创建仓库或上传文件。

## 1. 创建仓库

在自己的 GitHub 账号下创建仓库，建议名称为 universal-converter。
项目已包含 README、许可证和 Git 忽略规则，创建空仓库即可，不必让 GitHub 再生成这些文件。

可用的仓库描述：

> Windows 本地文件转换工具：中文界面，支持批量转换、引擎检测与安装、逐文件格式设置及诊断日志。

## 2. 上传源码

解压本包，将 **universal-converter-github 文件夹里面的内容** 放到仓库根目录。
上传后应能在仓库首页直接看到 README.md、package.json 和 main.js，不要额外套一层文件夹，也不要只上传这个源码 ZIP。

网页操作：仓库页面选择 Add file → Upload files，上传文件和子文件夹，再提交。参见 [GitHub 官方上传说明](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)。

使用 GitHub Desktop 也可以：先克隆空仓库，再将源码包内的内容复制到克隆目录，检查更改、提交并 Push。首次提交建议写：

```text
Add converter v0.3.0 source and documentation
```

确认根目录包含 .gitignore 和 .gitattributes。Git 忽略规则用于阻止依赖、日志和构建结果被后续提交；网页上传时仍应自己选择正确文件。

## 3. 发布可运行程序

源码提交完成后，在仓库 Releases 中创建一个发行版：

- Tag：v0.3.0
- 标题：万能文件转换器 v0.3.0
- 说明：可参考 CHANGELOG.md 的 v0.3.0 条目
- 附件：已有的“万能文件转换器_便携版_v0.3.0_Windows_x64.zip”

可以先保存为草稿。由于完整 Windows 实机回归尚未完成，首次公开发布建议标记为 Pre-release，验证后再调整。参见 [GitHub 官方 Releases 说明](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)。

不要将便携版 EXE、DLL 或数百 MB 的运行目录提交到源码仓库。GitHub 自动生成的 Source code ZIP 是源码，不是可以直接双击使用的便携版。

## 4. 后续维护

修改程序后，先运行 npm test；涉及转换时再运行 npm run test:integration。
保持 package.json、package-lock.json、界面版本及 CHANGELOG.md 一致，重新打包，再创建对应版本的 Release。

目前未配置自动发布工作流，不会因上传源码就自动发布新版本。
