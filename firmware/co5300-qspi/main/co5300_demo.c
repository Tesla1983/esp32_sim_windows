// ESP32-S3 + CO5300 QSPI AMOLED，给 esp32sim 的裸板 custom 模式跑。
//
// 接线：SPI2，SCLK=GPIO11，CS=GPIO12，数据只走 MOSI=GPIO13（单线）。真实模块是 4 线 QSPI
// （D0..D3），但模拟器只按 host + SCLK/CS 定位这块屏，数据线宽度不影响它的建模，所以这里
// 用普通 SPI 事务把同样的字节流发出去。
//
// CO5300 的 SPI 协议每包 4 字节头：`0x02 <0> <命令> <0>` 写命令，`0x32 <0> <命令> <0>` 写数据。
// 屏幕是 368×448，可见区从列 16 开始（面板 384 列，右侧 16 列不可见），所以 COLSET 要带上偏移。
//
// 模拟器的器件规格：--device 2:368:448:16:11:12:co5300
// 界面里：板子 custom → 添加 CO5300 屏 → Host=SPI2，SCLK 拖到 11、CS 拖到 12。

#include <stdlib.h>
#include <string.h>

#include "driver/spi_master.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "co5300";

#define PIN_SCLK 11
#define PIN_MOSI 13
#define PIN_CS   12

#define PANEL_W 368
#define PANEL_H 448
/// 面板共 384 列，可见的 368 列从第 16 列开始。
#define COL_OFFSET 16

/// 一次写的行数：368×8×2 = 5888 字节，连头 4 字节，一块 DMA 缓冲够用。
#define BAND_ROWS 8
#define BAND_BYTES (PANEL_W * BAND_ROWS * 2)
#define BUF_BYTES (BAND_BYTES + 4)

static spi_device_handle_t s_panel;
static uint8_t *s_buf;

/// 发一包。`op` 是 0x02（写命令）或 0x32（写数据），后者的负载是参数或像素。
static void send_packet(uint8_t op, uint8_t cmd, const uint8_t *payload, size_t len)
{
    if (len > BAND_BYTES) {
        ESP_LOGE(TAG, "payload %u exceeds the band buffer", (unsigned)len);
        abort();
    }
    s_buf[0] = op;
    s_buf[1] = 0x00;
    s_buf[2] = cmd;
    s_buf[3] = 0x00;
    // 像素直接铺在 s_buf+4 上时不能再 memcpy 一次（源和目的同一块）。
    if (len && payload != s_buf + 4) {
        memcpy(s_buf + 4, payload, len);
    }
    spi_transaction_t t = {
        .length = (4 + len) * 8,
        .tx_buffer = s_buf,
    };
    ESP_ERROR_CHECK(spi_device_transmit(s_panel, &t));
}

static void write_command(uint8_t cmd)
{
    send_packet(0x02, cmd, NULL, 0);
}

static void set_window(uint16_t x0, uint16_t x1, uint16_t y0, uint16_t y1)
{
    const uint8_t cols[4] = {x0 >> 8, x0 & 0xff, x1 >> 8, x1 & 0xff};
    const uint8_t rows[4] = {y0 >> 8, y0 & 0xff, y1 >> 8, y1 & 0xff};
    send_packet(0x02, 0x2A, cols, sizeof cols);
    send_packet(0x02, 0x2B, rows, sizeof rows);
}

/// 用一条随时间右移的高亮列 + 八条竖色条画画，肉眼能看出是在刷新。
static void draw_frame(uint32_t frame)
{
    static const uint16_t bars[8] = {
        0xF800, 0xFD20, 0xFFE0, 0x07E0, 0x07FF, 0x001F, 0xF81F, 0xFFFF,
    };
    const uint16_t highlight = frame % PANEL_W;

    for (int y = 0; y < PANEL_H; y += BAND_ROWS) {
        const uint16_t y1 = (y + BAND_ROWS - 1 < PANEL_H) ? (y + BAND_ROWS - 1) : (PANEL_H - 1);
        set_window(COL_OFFSET, COL_OFFSET + PANEL_W - 1, y, y1);

        uint8_t *p = s_buf + 4;
        for (int row = 0; row < (y1 - y + 1); row++) {
            for (int x = 0; x < PANEL_W; x++) {
                uint16_t px = (x >= highlight && x < highlight + 2) ? 0xFFFF : bars[x * 8 / PANEL_W];
                *p++ = px >> 8;
                *p++ = px & 0xff;
            }
        }
        send_packet(0x32, 0x2C, s_buf + 4, (size_t)(y1 - y + 1) * PANEL_W * 2);
    }
}

void app_main(void)
{
    spi_bus_config_t bus = {
        .mosi_io_num = PIN_MOSI,
        .miso_io_num = -1,
        .sclk_io_num = PIN_SCLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = BUF_BYTES,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));

    spi_device_interface_config_t dev = {
        .clock_speed_hz = 20 * 1000 * 1000,
        .mode = 0,
        .spics_io_num = PIN_CS,
        .queue_size = 1,
    };
    ESP_ERROR_CHECK(spi_bus_add_device(SPI2_HOST, &dev, &s_panel));

    s_buf = heap_caps_malloc(BUF_BYTES, MALLOC_CAP_DMA);
    if (!s_buf) {
        ESP_LOGE(TAG, "no DMA-capable buffer for %u bytes", (unsigned)BUF_BYTES);
        abort();
    }

    ESP_LOGI(TAG, "wired on SCLK=%d CS=%d MOSI=%d, panel %dx%d at column %d",
             PIN_SCLK, PIN_CS, PIN_MOSI, PANEL_W, PANEL_H, COL_OFFSET);

    write_command(0x01);              // SWRESET
    vTaskDelay(pdMS_TO_TICKS(20));
    write_command(0x11);              // SLPOUT
    vTaskDelay(pdMS_TO_TICKS(20));
    send_packet(0x02, 0x3A, (const uint8_t[]){0x55}, 1);   // COLMOD: RGB565
    write_command(0x21);              // INVON：这块 AMOLED 需要反显才正色
    write_command(0x29);              // DISPON

    for (uint32_t frame = 0;; frame++) {
        draw_frame(frame);
        ESP_LOGI(TAG, "frame %u drawn, %d bands of %d rows", (unsigned)frame,
                 PANEL_H / BAND_ROWS, BAND_ROWS);
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
