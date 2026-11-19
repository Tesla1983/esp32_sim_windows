# esp32sim desktop

esp32sim 的 Windows 桌面启动器：选固件、点运行，在同一个窗口里看板面、串口与网络面板，改完固件自动重启。

- 上游模拟器：[mikroverk/esp32sim](https://github.com/mikroverk/esp32sim) main 基线 `d043ff1`（MIT；比 v0.4.0 新 18 个提交）
- 本壳：Tauri 2 + WebView2，sidecar 调用上游原生二进制
- 平台：Windows 10 1809+ / 11 x64

## 快速开始

1. 解压 `dist/esp32sim-desktop_0.1.0_x64-portable.zip`，或安装 `dist/esp32sim desktop_0.1.0_x64-setup.exe`（需 WebView2 运行时，Win10 1809+ / Win11 通常自带）。
2. 准备 mask ROM（不随包分发）：放到 `roms\`，或让程序从 ESP-IDF 的 `%USERPROFILE%\.espressif\tools\esp-rom-elfs` 自动查找。
3. 在界面里填 ESP-IDF / PlatformIO 的 build 目录，点「识别」，再点「运行」。build 目录需含 `bootloader.bin`、`partition-table.bin` 与 app 的 `.bin`/`.elf`。

## 界面速查

| 区域 | 说明 |
|---|---|
| 芯片 / 板子 | 板子名须与芯片匹配，例如 `atech14` 只用于 ESP32-S3 |
| 接线画布 | 板子选 `custom` 时可用：按 DevKitC-1 丝印拖器件、拉线，自动回填引脚与 `--device` |
| 固件 | build 目录 + 三件套 + 可选 ELF |
| ROM | 留空自动查找 |
| 模块 | Flash / PSRAM 大小按固件编译配置填 |
| 网络 | 填 SSID 启用虚拟 AP，固件可经 NAT 访问真实网络 |
| 输出 | 截图 / 音频 / 波形文件保存路径 |
| 自动化 | 勾选后监视 build 目录，产物更新即自动重启 |
| 工程 | 保存 / 加载配置（`%APPDATA%\dev.esp32sim.desktop\project.json`） |

## 常见错误

| 提示 | 原因 | 处理 |
|---|---|---|
| `找不到 <chip> 的 mask ROM` | ROM 不在自动查找路径 | 放到 `roms\` 或手动指定 |
| `bootloader 文件不存在` | 路径被移动或未识别 | 重选 build 目录并点「识别」 |
| `not an ESP image` | 把整包 flash 当成了 app | 改用三件套 |
| 启动后立刻重启 / 卡在 bootloader | Flash / PSRAM 大小与固件不符 | 按 `idf.py menuconfig` 配置填 |
| 串口没有输出 | 控制台选错（UART0 vs USB-CDC） | 在 board 页切换 Console 标签 |

## 构建

```powershell
git clone https://github.com/mikroverk/esp32sim.git vendor/esp32sim
git -C vendor/esp32sim checkout d043ff1dd3e53aca18a23f4f2b18bfb038a57667
git -C vendor/esp32sim apply patches\vendor-esp32sim-local.patch
powershell -ExecutionPolicy Bypass -File scripts\build-sidecar.ps1
node scripts\stage-web.cjs
cd src-tauri
cargo tauri build
```

`vendor/esp32sim/` 不入库，本地对内核的改动统一放在 `patches/vendor-esp32sim-local.patch`，
上面第 3 步 `git apply` 就是把这些改动打回去。补丁基线是 fork 的 `3a81c3b`（含 `--buslog`），
在干净检出上已验证可应用。当前补丁内容：

- 裸板 `--device` 的 I2C 形式支持 `BUS:ADDR:SDA:SCL:MODEL`，器件按物理引脚过滤（线没接就不应答）
- 裸板 `--device` 的 QSPI 形式支持 `HOST:WIDTH:HEIGHT:XOFF:SCLK:CS:co5300`，事务必须落到这两根线
- SPI flash 的 suspend/resume（0x75/0x7A）与 SFDP 探测，避免 IDF 开自动挂起后启动断言

产物：

- `src-tauri\target\release\esp32sim-desktop.exe`
- `src-tauri\target\release\bundle\nsis\esp32sim desktop_0.1.0_x64-setup.exe`

## 目录

| 路径 | 内容 |
|---|---|
| `src/` | 主界面（原生 HTML/CSS/JS） |
| `src-tauri/` | Rust 后端：sidecar 启停、端口、ROM 查找、目录监视、工程读写 |
| `scripts/` | 构建脚本 |
| `resources/web/` | 由 `stage-web.cjs` 生成的上游板面资源（含 embed 补丁，不入库） |
| `vendor/esp32sim/` | 上游源码（构建依赖，不入库） |

## 验收

已在 Windows x64 上验证：启动、固件三件套识别、sidecar 拉起、板面加载与串口日志均正常。

## 许可

本壳 MIT。上游 esp32sim MIT；mask ROM 为 Espressif Apache-2.0，不随包分发。第三方声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
