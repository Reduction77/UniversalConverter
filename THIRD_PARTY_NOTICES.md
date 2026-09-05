# 第三方组件

本仓库仅分发应用源码与自身资源，不包含外部转换引擎二进制。

package-lock.json 记录 JavaScript 依赖。Electron 与 Electron Packager 由 npm 安装，分别遵循上游许可证。构建发布包时应保留 Electron 自动附带的 LICENSE、LICENSES.chromium.html 等许可文件。

外部转换功能调用用户安装的 FFmpeg、ImageMagick、LibreOffice、Pandoc、Calibre、7-Zip 和 Ghostscript。它们不受本项目 MIT 许可证覆盖；不同组件和构建版本的许可证及分发条件不同。

若后续把任何转换引擎打包进发布版本，需要针对所使用的具体版本核对并履行其许可要求。
