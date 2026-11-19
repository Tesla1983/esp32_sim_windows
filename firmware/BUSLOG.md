# 给 AI 读的总线日志（buslog）

`esp32sim` 的 `--buslog FILE` 把仿真过程里的总线活动写成**紧凑文本**，可以直接给 AI 读，
不需要波形查看器。这是 `esp32sim-desktop` 界面上「总线日志（给 AI 读）」输入框对应的参数。

## 用法

命令行：

```
esp32sim.exe ... --buslog out/buslog.txt
```

桌面壳：`输出（可选）` → `总线日志（给 AI 读）` 填路径 → 点运行 → 用「打开输出目录」查看。

日志分三段：

```
# buslog: t=seconds since reset, g<pin>^=high g<pin>v=low   ← GPIO 边沿（同一时刻合并成一行）
0.084451  g14v g40v g12v
... 0.184s idle ...                                          ← 长空闲折叠，不刷屏

# decoded bus transactions                                   ← 解码后的 SPI 事务
[buslog] gpspi: 256 master transactions (host, first 64 bytes)
[buslog]   #6   host2 cf
[buslog]   #7   host2 00 aa e0
[buslog]   #8   host2 ed
[buslog]   #12  host2 cb 39 2c 00 34 02
```

## 三段各回答什么问题

| 段 | 回答的问题 | 典型用途 |
|---|---|---|
| GPIO 边沿 | CS/DC/RS 在什么时候翻转 | bit-bang 屏的片选时序 |
| 解码的 SPI 事务 | 固件到底发了哪些命令字节 | 验证 ILI9341/BMP280 初始化序列 |
| I2C（见下） | I2C 地址、命令、读数 | 验证 AHT20/LSM6DS3/SH1106 |

## I2C：配合 `--debug i2c`

I2C 事务日志已内置，用 `--debug i2c` 开启（走 stderr，重定向到文件）：

```
esp32sim.exe ... --buslog out/buslog.txt --debug i2c 2> out/i2c.txt
```

输出形如：

```
[i2c] start addr 0x3c read=false
[i2c]   write 0x00
[i2c]   write 0xaf
```

对 SH1106 就是「控制字节 0x00（命令）+ 0xAF（display on）」——AI 能直接核对命令序列。

硬件 SPI（GPSPI）用 `--debug spi` 可看到 flash 级事务；屏幕级字节由 `--buslog` 的解码段提供。

## 实测样例：ILI9341 初始化

用一块 ILI9341 工程编出来的固件 + `--device 12:11:10:14:ili9341` 跑 3 秒，`buslog.txt`
的解码段直接给出 ILI9341 的标准初始化序列：

```
#6  cf          Power Control 1
#8  ed          Power on sequence control
#10 e8          EQ control
#12 cb 39 2c…   Power Control 2
```

AI 拿到这个就能判断"初始化命令发没发、顺序对不对"，不必看图、不必接逻辑分析仪。

## 限制

- GPIO 段只记录**边沿**（电平变化），不是固定周期采样；对数字时序这已经够。
- 解码段每笔事务最多存前 64 字节、最多 256 笔——防止刷屏数据把文件撑爆。
- bit-bang SPI 的解码段按 CS 下降/上升分帧，但**不记录 D/C（RS）电平**；要区分命令/数据，
  结合 GPIO 段里 DC 脚的翻转时间判断。
- I2C 事务目前走 `--debug i2c`（stderr），未合并进 `buslog.txt`；这是有意的，避免改动
  I2C 泛型控制器带来的回归风险。
