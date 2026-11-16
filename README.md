# esp32sim desktop

esp32sim 的 Windows 桌面启动器：选固件、点运行，在同一个窗口里看板面、串口与网络面板，改完固件自动重启。

- 上游模拟器：[mikroverk/esp32sim](https://github.com/mikroverk/esp32sim) v0.4.0（MIT）
- 本壳：Tauri 2 + WebView2，sidecar 调用上游原生二进制
- 平台：Windows 10 1809+ / 11 x64

## 快速开始

1. 解压 `dist/esp32sim-desktop_0.1.0_x64-portable.zip`，或安装 `dist/esp32sim desktop_0.1.0_x64-setup.exe`。
2. 准备 mask ROM（不随包分发）：放到 `roms\`，或让程序从 ESP-IDF 的 `~/.espressif/tools/esp-rom-elfs` 自动查找。
3. 在界面里填 ESP-IDF / PlatformIO 的 build 目录，点「识别」，再点「运行」。

详见 [docs/USAGE.md](docs/USAGE.md)。

## 构建

```powershell
git clone --depth 1 --branch v0.4.0 https://github.com/mikroverk/esp32sim.git vendor/esp32sim
powershell -ExecutionPolicy Bypass -File scripts\build-sidecar.ps1
node scripts\stage-web.cjs
cd src-tauri
cargo tauri build
```

产物：

- `src-tauri\target\release\esp32sim-desktop.exe`
- `src-tauri\target\release\bundle\nsis\esp32sim desktop_0.1.0_x64-setup.exe`

## 目录

| 路径 | 内容 |
|---|---|
| `src/` | 主界面（原生 HTML/CSS/JS） |
| `src-tauri/` | Rust 后端：sidecar 启停、端口、ROM 查找、目录监视、工程读写 |
| `scripts/` | 构建与验收脚本 |
| `resources/web/` | 由 `stage-web.cjs` 生成的上游板面资源（含 embed 补丁，不入库） |
| `docs/` | 计划书、验收记录、使用说明、截图 |
| `vendor/esp32sim/` | 上游源码（构建依赖，不入库） |

## 验收

见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。A1–A6、A8–A10 已通过；A7（30 分钟长跑）待补测。

## 许可

本壳 MIT。上游 esp32sim MIT；mask ROM 为 Espressif Apache-2.0，不随包分发。第三方声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
