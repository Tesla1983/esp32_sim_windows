---
name: esp32sim-desktop
description: >-
  esp32sim 模拟器的项目内验证工具：构建 sidecar / 板面资源 / 桌面壳，用 --device 规格跑固件，
  解析给 AI 读的总线日志，导出面板截图。当用户提到 esp32sim、模拟器、custom 裸板、--device、
  总线日志、buslog、面板截图、验证固件在模拟器里有没有跑起来时自动触发，也兼容显式调用。
  即使用户只说"跑一下模拟器""看看屏亮没亮""把这次的总线事务整理一下"，只要上下文是本项目就应触发。
argument-hint: "[build|run|buslog|panel-shot] ..."
---

# esp32sim 模拟器验证

把本仓库已有的构建脚本、sidecar 与日志格式包成结构化命令。**只操作软件模拟器，不接触探针、
COM 口、J-Link / OpenOCD / probe-rs 或任何真实硬件**；这与本项目的硬件安全约定一致。

## 运行依赖

- Node.js 18+（本机 v22 可用），无需额外 pip / npm 依赖
- 已在仓库内的脚本：`scripts/build-sidecar.ps1`、`scripts/stage-web.cjs`
- 构建 sidecar / 桌面壳需要 Rust 工具链（cargo 从 `CARGO_HOME/bin` 或 `~/.cargo/bin` 自动补 PATH）
- 跑仿真需要 `dist/portable/esp32sim.exe` 与固件三件套；mask ROM 优先用仓库 `roms/`，
  否则由 sidecar 自己从 ESP-IDF 的 esp-rom-elfs 发现

## 配置

技能级配置在 `.workbuddy/skills/esp32sim-desktop/config.json`（相对仓库根）：

```json
{
  "sidecar": "dist/portable/esp32sim.exe",
  "build_sidecar": "scripts/build-sidecar.ps1",
  "stage_web": "scripts/stage-web.cjs",
  "max_seconds": 8,
  "operation_mode": 1
}
```

参数优先级（高 → 低）：CLI 显式参数 > 环境变量 `ESP32SIM_EXE` / `ESP32SIM_MAX_SECONDS` >
技能 `config.json` > 默认值。

`operation_mode`：`1` 直接执行 / `2` 只预览命令不执行。默认始终 `1`，且**不存在**"降低风险后仍
自动执行"的隐式路径——需要预览就显式传模式 `2` 或编辑 config。

## 子命令

| 子命令 | 用途 | 风险 |
|---|---|---|
| `build` | 构建 sidecar、板面资源、桌面壳，或只构建其中一项 | 中（会覆盖二进制） |
| `run` | 用 `--device` 规格跑固件，返回帧数、错误与产物 | 低（纯软件） |
| `buslog` | 解析 `--buslog` 文本，给出 GPIO 边沿与 SPI/I2C 事务摘要 | 低（只读） |
| `panel-shot` | 跑一次仿真并用 `--tft-png` 导出面板截图 | 低（纯软件） |

## 执行流程

1. 未提供或提供未知子命令时直接报错，绝不猜用户想执行哪个。
2. `build` 默认三项全做；`--sidecar` / `--web` / `--shell` 只做指定项。构建成功后返回产物
   路径与大小；任一步失败，返回 `error.code=build_failed` 并附上 stderr 末尾 30 行。
3. `run` 总是带 `--max-seconds`（默认 8）以保证进程会退出；`--no-dump` 默认开启，
   需要寄存器 dump 时显式加 `--dump`。可以从 GUI 的工程配置 JSON 读固件与器件：
   `--config <file>`，其中 `devices[]` 会按前端同样规则编译成 `--device` SPEC——只有真正连过
   SDA/SCL 或 SCLK/CS 的器件才下发引脚。
4. `run` 的输出里解析 `[emu] panel: N frames, WxH`、controller found / not found、panic/assert。
   面板 0 帧且配了屏器件时，`next_actions` 会提示检查物理连线。
5. `panel-shot` = `run --tft-png <file>`，额外回读 PNG 头拿到真实宽高。多面板时同目录的
   `*-1.png`、`*-2.png` 等会一并列进 `details.images`。
6. `buslog` 只读文本：GPIO 边沿按行计数并收集引脚号、折叠的 idle 段计数、GPSPI 事务按
   `#序号 host 字节` 解析；`--i2c FILE` 可选，把 `--debug i2c` 的 stderr 输出也归组进来。

## 脚本调用

所有命令只有一个入口，且只往 stdout 写一份 JSON：

```bash
# 构建：全部 / 单项 / 只预览
node .workbuddy/skills/esp32sim-desktop/scripts/esp32sim.cjs build --all
node .workbuddy/skills/esp32sim-desktop/scripts/esp32sim.cjs build --sidecar
node .workbuddy/skills/esp32sim-desktop/scripts/esp32sim.cjs build --all --operation-mode=2

# 直接跑：手工给三件套与 SPEC
node .workbuddy/skills/esp32sim-desktop/scripts/esp32sim.cjs run \
  --chip s3 --board custom --app firmware/co5300-qspi/build/co5300-qspi.bin \
  --bootloader firmware/co5300-qspi/build/bootloader/bootloader.bin \
  --ptable firmware/co5300-qspi/build/partition_table/partition-table.bin \
  --flash-mb 16 --psram-mb 0 --device 2:368:448:16:11:12:co5300 \
  --buslog .workbuddy/state/esp32sim-desktop/last-buslog.txt --max-seconds 8

# 从 GUI 工程配置跑
node .workbuddy/skills/esp32sim-desktop/scripts/esp32sim.cjs run --config <project.json>

# 面板截图 / 总线日志解析
node .workbuddy/skills/esp32sim-desktop/scripts/esp32sim.cjs panel-shot \
  --config <project.json> --tft-png out/panel.png --max-seconds 6
node .workbuddy/skills/esp32sim-desktop/scripts/esp32sim.cjs buslog \
  --file .workbuddy/state/esp32sim-desktop/last-buslog.txt --tail 12
```

## 输出格式

```json
{
  "status": "ok",
  "action": "run",
  "summary": "面板 896 帧 368x448",
  "details": { "command": "...", "devices": ["..."], "parsed": {} },
  "metrics": { "gpio_edges": 123, "gpspi_transactions": 256 },
  "artifacts": [{ "path": "...", "bytes": 208208, "mtime": "..." }],
  "next_actions": ["buslog --file ..."]
}
```

错误固定为：

```json
{ "status": "error", "action": "run", "error": { "code": "sidecar_missing", "message": "...", "details": {} } }
```

`metrics` 只在 `buslog` 中出现；`artifacts` 在 `build` / `run` / `panel-shot` / `buslog` 中出现。

## 核心规则

- 不自动猜测工程路径、芯片或器件 SPEC。缺 bootloader / ptable / app 时直接报 `sidecar_missing`
  或让 sidecar 报错，不替用户填路径。
- 不碰真实硬件：没有 flash / erase / reset / read-mem / COM 口操作；不要为了"顺便验证"去调用
  仓库外的探针工具。
- `run` 与 `panel-shot` 必须带 `--max-seconds`，默认 8 秒仿真时间；宿主侧超时默认 180 秒。
- 构建会覆盖 `dist/portable/` 与 `src-tauri/binaries/` 下的二进制；不确定时先用 `operation_mode=2`
  预览。
- 构建失败时优先展示 stderr 末尾，不要臆测原因。
- `buslog` 是只读的：不改日志文件，不删旧产物。
