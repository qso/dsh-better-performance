# DSH Afterburn

A desktop performance plugin for DeepSeek Harness. Keep recently visited sessions ready, start folder listings immediately, and reduce the time spent waiting for file previews. Tested with DSH Desktop 0.2.2-rc.5 on macOS.

## 安装

在 DSH 插件管理器中通过 GitHub 安装 `github:qso/dsh-afterburn#v0.1.0`，启用后重启 DSH。也可克隆本仓库，运行 `npm ci --ignore-scripts` 后在本地插件安装入口选择仓库目录。可单独使用，也可搭配 [DSH Dockline](https://github.com/qso/dsh-dockline)。

## 工作方式

- 默认最多保留 3 个最近使用的会话，离开 5 分钟后释放。会话越大，保留期间占用的内存越多。首次打开仍需载入历史。
- 首次打开目录时并行开始读取和建立监听，监听就绪后再核对目录。macOS 本地文件系统在独立线程观察当前正在浏览的目录，避免切换会话时监听器的关闭阻塞宿主。
- 点击文件即开始准备预览，同一次打开复用进行中的读取。较大的图片等二进制文件通过 DSH 自带的同源、带版本的媒体地址传输，同时遵守宿主读取上限。预览继续使用宿主的文件权限。
- 配置与观察仅作用于当前 DSH。数据通过当前 DSH 连接传输。本插件没有分析服务、远程资源或自己的文件持久缓存。

## 配置

在 DSH 的插件配置中调整以下选项。也可以在配置该插件的 Cordis 条目上设置同名的 `config` 值，重启后生效。

| 选项 | 默认值 | 用途 |
| --- | --- | --- |
| `maxSessions` | 3 | 最近保留会话数，0 关闭，最多 8 |
| `retainMinutes` | 5 | 退出前台后的保留分钟数，1–30，每 30 秒清理 |
| `macWatch` | true | macOS 本地文件观察线程 |
| `pollMs` | 500 | 普通文件变化检查间隔，200–5000 毫秒 |
| `binaryPollMs` | 1000 | 二进制文件检查间隔，200–10000 毫秒 |
| `idleWatchMs` | 1500 | 闲置监听复用时间，0–10000 毫秒，最多留 8 个 |
| `earlyDirectoryReads` | true | 首次展开时提前读取目录 |
| `previewIntent` | true | 指针或键盘选中文件时预备读取 |
| `fastBytes` | true | 对允许的完整读取使用宿主媒体传输 |

如果希望更快看到其他程序修改的内容，可以缩短检查间隔。目录特别大或电池供电时可以延长间隔。禁用插件并重启即可恢复宿主默认行为。DSH 更新可能改变会话、观察及预览接口，升级后请复测。

## Development

Use Node.js 22.19 or later. Run `npm ci --ignore-scripts`, `npm test`, and `npm pack --dry-run`. The worker test creates a new file in a temporary directory. The session test covers switching back to a retained session and cleanup. MIT licensed.
