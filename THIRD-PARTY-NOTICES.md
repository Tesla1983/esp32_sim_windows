# 第三方组件与授权

本应用是 mikroverk/esp32sim 的桌面启动器，自身以 MIT 授权发布。随包分发或运行时依赖的第三方内容如下。

## esp32sim

- 项目：https://github.com/mikroverk/esp32sim
- 版本：v0.4.0
- 授权：MIT
- 使用方式：以未修改的上游源码编译出 `esp32sim.exe`，作为外置进程（sidecar）调用；`web/` 下的板面资源原样复制，仅追加一段 `?embed=1` 时生效的样式补丁。

## mask ROM

- 来源：https://github.com/espressif/esp-rom-elfs
- 授权：Apache-2.0
- 说明：**不随应用分发**。程序只在本机查找或引导用户自行获取。

## xterm.js

- 项目：https://github.com/xtermjs/xterm.js
- 授权：MIT
- 说明：位于 `web/vendor/`，由上游页面用于 UART0 终端视图。

## 演示固件

- pocket-tank（MIT）、MicroPython（MIT）、Linux-on-esp32-S3（GPL-3.0）等演示资源由上游仓库或运行时下载，**不包含在本安装包内**。

## Tauri 与 Rust 依赖

- Tauri 2（Apache-2.0 / MIT）
- tauri-plugin-shell（Apache-2.0 / MIT）
- tauri-plugin-single-instance（Apache-2.0 / MIT）
- notify（CC0-1.0）
- serde / serde_json（Apache-2.0 / MIT）

完整依赖树可用 `cargo metadata` 或安装包内的许可证声明核对。
