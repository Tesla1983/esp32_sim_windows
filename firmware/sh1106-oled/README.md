# SH1106 1.3" OLED 示例固件

给 esp32sim 的裸板（`custom` 板）用的最小 ESP-IDF 工程：ESP32-S3 通过 I2C 驱动一块 SH1106
128×64 单色 OLED，逐秒刷新开机时长与一条扫动进度条，控制台同时打印自检信息。

## 编译

需要 ESP-IDF v6.1（EIM 安装，含 Xtensa 工具链）。

```sh
idf.py set-target esp32s3
idf.py build
```

产物在 `build/`：`bootloader/bootloader.bin`、`partition_table/partition-table.bin`、
`sh1106-oled.bin`、`sh1106-oled.elf`。flash 头按 16 MB 声明（与启动器默认的 16 MB 一致），
单 app 分区，app 约 195 KB。

## 在模拟器里跑

1. 打开 `dist\portable\esp32sim-desktop.exe`。
2. 芯片选 `esp32s3`，板子选 `custom（裸板自由搭配）`。
3. 器件区添加 `SH1106 1.3″ OLED（I2C）`，总线 `0`、地址 `0x3c`。
4. 构建目录填本目录下的 `build`，点「识别」自动填好 bootloader / 分区表 / 应用镜像；
   ELF 也会一起填上，方便出错时看调用栈。
5. 点运行。右侧 Panel 卡里应出现 128×64 画面：左上 `ESP32-S3`、右上 `SH1106`、
   中间 3 倍大的秒数、左下 `I2C 0x3C`、底部每秒扫一次的空心进度条。

I2C 用 GPIO4（SDA）/ GPIO5（SCL）。模拟器按总线编号路由器件，引脚只作记录，接哪两个脚都能通。

**为什么不用常见的 8/9**：ESP-IDF 6.x 在启动早期会把 GPIO0 和 GPIO8 登记成"已被占用"，
于是 I2C 驱动配置 GPIO8 时会打印 `GPIO 8 is not usable, maybe conflict with others`。
源头是 `spi_flash` 的 `esp_mspi_pin_reserve()`：它从 ROM 的 `ets_efuse_get_spiconfig()`
取 flash 引脚配置，模拟器里这个值是 `0x8`，按每 6 位一个引脚解析成 `8 0 0 0 0 0`
（CLK=8，其余 Q/D/CS/HD/WP=0），于是 0 和 8 被 flash 抢先登记。真实芯片未烧 efuse 时
走默认引脚 26..32，不会占 0/8，所以这是模拟器 efuse 数据的差异。警告不影响功能
（I2C 照样接管并 probe 成功），换到 4/5 只是让日志干净。

## 两点实现说明

- **列偏移**：SH1106 是 132 列的显存、玻璃只显示中间 128 列，所以每页起始列要写 `x + 2`
  （`COL_OFFSET`）。少写这 2，画面整体左移两列并把右边两列挤掉。
- **扫描方向**：本工程用 `0xA0`（不重映射段）+ `0xC0`（COM 正扫），让写进显存的左上角
  就是玻璃的左上角。部分实物模块的排线是反的，需要改成 `0xA1` + `0xC8` 才是正的；
  模拟器的模型按 `0xA0/0xC0` 为"正"，换到实物时先看一眼方向再定。

控制台（Console → UART0）里能看到：

```
[sh1106] found a controller at 0x3C on I2C0 (SDA 4, SCL 5)
[sh1106] initialised: 128x64, page addressed, column offset 2
[sh1106] uptime 1 s, 6 frames
```

正常启动不应出现任何 `W`/`E` 级日志。若看到
`spi_flash: Detected size(16384k) larger than the size in the binary image header(2048k)`，
说明镜像头的 flash 尺寸小于模拟器提供的容量：bootloader 会退回用头部那个较小的值，
功能不受影响（分区表本来就只描述前 2 MB），但把 `CONFIG_ESPTOOLPY_FLASHSIZE` 调成与
`--flash-mb` 一致即可消掉。注意 `sdkconfig.defaults` 只在**首次生成** `sdkconfig` 时生效，
已有工程要直接改 `sdkconfig`（或在 `idf.py menuconfig` 里改）。
