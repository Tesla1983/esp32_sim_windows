# CO5300 QSPI AMOLED 示例固件

给 esp32sim 的裸板（`custom` 板）用的最小 ESP-IDF 工程：ESP32-S3 通过 SPI2 驱动一块
368×448 的 CO5300 AMOLED，画 8 条竖色条 + 一条每秒右移的高亮列，控制台同时打印每帧信息。

这个工程的存在意义是**验证"屏要连对线才亮"这条链路**：模拟器把面板绑定到 SCLK/CS 两个物理引脚，
接线不对时固件照常发数据、屏却不接收。

## 接线

| 信号 | GPIO |
|---|---|
| SCLK | 11 |
| CS | 12 |
| MOSI（数据只走单线） | 13 |

真实模块是 4 线 QSPI（D0–D3 = 4/5/6/7）。模拟器用 host + SCLK/CS 定位这块屏，不建模数据线宽度，
所以这里用普通 SPI 单线把同样的字节流发出去就够了；若要接真实硬件，把 `quadwp/quadhd` 和
`SPI_TRANS_MODE_QIO` 补上即可。

## 编译

需要 ESP-IDF v6.1（EIM 安装，含 Xtensa 工具链）。Git Bash 里 `MSYSTEM` 会干扰 IDF 的 shell
检测，所以用仓库里的包装脚本，它负责清环境、补 PATH、自动挑出最新的工具链：

```sh
export IDF_PATH=<esp-idf 目录>
export IDF_TOOLS_PATH=<EIM 的工具目录>
node ../_idf.js -C . set-target esp32s3
node ../_idf.js -C . build
```

改动 `sdkconfig.defaults` 之后要先删 `sdkconfig` 再构建，否则不会生效；
若 flash 大小仍是 2 MB，直接改 `sdkconfig` 里的 `CONFIG_ESPTOOLPY_FLASHSIZE` 三行（本工程已改成 16 MB）。

产物在 `build/`：`bootloader/bootloader.bin`、`partition_table/partition-table.bin`、
`co5300-qspi.bin`、`co5300-qspi.elf`，app 约 208 KB。

## 在模拟器里跑

命令行（已验证）：

```sh
dist/portable/esp32sim.exe --chip s3 --board custom --flash-mb 16 --psram-mb 0 \
  --boot rom --rom roms/esp32s3_rev0_rom.elf \
  --bootloader firmware/co5300-qspi/build/bootloader/bootloader.bin \
  --ptable firmware/co5300-qspi/build/partition_table/partition-table.bin \
  --app firmware/co5300-qspi/build/co5300-qspi.bin \
  --console uart0 --max-seconds 8 --no-dump \
  --device 2:368:448:16:11:12:co5300
```

界面里：芯片 `ESP32-S3`、板子 `custom`，添加 `CO5300 屏（QSPI）`，
Host 选 `SPI2`、宽高 `368×448`、偏移 `16`，SCLK 拖到 GPIO11、CS 拖到 GPIO12，
再填 `build` 目录并点「识别」。

## 预期结果

| 情况 | 模拟器报告 |
|---|---|
| SCLK=11、CS=12（接对） | `[emu] panel: 896 frames, 368x448`（8 秒 / 每帧 56 段） |
| SCLK=4、CS=12（接错时钟） | `[emu] panel: 0 frames, 368x448` |

两种情况固件日志都一样（`frame N drawn, 56 bands of 8 rows`），差别只在屏有没有收到——
这正是要验证的点：模拟器按物理引脚过滤，不看固件"以为"自己发给了谁。

## 协议要点

CO5300 的 SPI 每包 4 字节头：`0x02 <0> <命令> <0>` 写命令，`0x32 <0> <命令> <0>` 写数据。
面板 384 列、可见 368 列从第 16 列起，所以 COLSET 要写 `16..383`。
每个 8 行带都要重设窗口再写 `0x2C`：模拟器把每次 `0x2C` 当作一次新的帧写入并回到窗口原点，
不重设窗口就会一直往同一块区域覆盖。
