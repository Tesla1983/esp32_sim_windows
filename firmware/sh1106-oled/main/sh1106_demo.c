// ESP32-S3 + SH1106 128×64 OLED，给 esp32sim 的裸板 custom 模式跑。
//
// 接线（模拟器里按总线编号路由，引脚只需真实可信）：I2C0，SDA=GPIO4，SCL=GPIO5，器件地址 0x3C。
// 界面里：板子选 custom → 添加器件 SH1106 1.3" → 总线 0、地址 0x3c。
//
// 引脚为什么不是常见的 8/9：ESP-IDF 6.x 会在启动早期就把 GPIO0 和 GPIO8 登记成"已占用"
// （实测 app_main 第一行打印 reserved = 0 8 22 23 24 25，其中 22..25 是 S3 上不存在的脚）。
// 于是 I2C 驱动配置 GPIO8 时会打印 "GPIO 8 is not usable, maybe conflict with others"。
// 这条警告不影响功能（I2C 照样接管引脚、probe 成功），但日志不干净；换成无人登记的 4/5 即可。
//
// 该控制器是 132×8 页寻址 GDDRAM，玻璃只显示第 2..129 列，所以每页起始列要写 x+2。

#include <stdio.h>
#include <string.h>

#include "driver/i2c_master.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "sh1106";

#define OLED_SDA 4
#define OLED_SCL 5
#define OLED_ADDR 0x3C
#define OLED_W 128
#define OLED_H 64
/// The glass shows GDDRAM columns 2..129 on a 132-column controller.
#define COL_OFFSET 2

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_oled;

// ------------------------------------------------------------------ 5x7 font
// 只覆盖本示例用到的字符，写成 7 行 × 5 列的位图，肉眼可校对。

typedef struct {
    char ch;
    const char *rows[7];
} glyph_t;

static const glyph_t FONT[] = {
    {'0', {".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."}},
    {'1', {"..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."}},
    {'2', {".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"}},
    {'3', {"####.", "....#", "....#", ".###.", "....#", "....#", "####."}},
    {'4', {"...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."}},
    {'5', {"#####", "#....", "####.", "....#", "....#", "#...#", ".###."}},
    {'6', {"..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."}},
    {'7', {"#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."}},
    {'8', {".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."}},
    {'9', {".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."}},
    {'C', {".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."}},
    {'E', {"#####", "#....", "#....", "####.", "#....", "#....", "#####"}},
    {'H', {"#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"}},
    {'I', {".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."}},
    {'P', {"####.", "#...#", "#...#", "####.", "#....", "#....", "#...."}},
    {'S', {".###.", "#...#", "#....", ".###.", "....#", "#...#", ".###."}},
    {'x', {".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"}},
    {'-', {".....", ".....", ".....", "#####", ".....", ".....", "....."}},
};

/// Per-character advance at scale 1: five columns plus one blank column.
#define GLYPH_W 5
#define ADVANCE 6

// -------------------------------------------------------------- framebuffer
// Page-major, exactly the controller's layout: fb[page][column], bit 0 the page's top row.
static uint8_t s_fb[OLED_H / 8][OLED_W];

static void fb_clear(void) { memset(s_fb, 0, sizeof(s_fb)); }

static void fb_pixel(int x, int y, int on)
{
    if (x < 0 || x >= OLED_W || y < 0 || y >= OLED_H) {
        return;
    }
    uint8_t bit = (uint8_t)(1u << (y & 7));
    if (on) {
        s_fb[y >> 3][x] |= bit;
    } else {
        s_fb[y >> 3][x] &= (uint8_t)~bit;
    }
}

static void fb_rect(int x, int y, int w, int h, int on)
{
    for (int dy = 0; dy < h; dy++) {
        for (int dx = 0; dx < w; dx++) {
            fb_pixel(x + dx, y + dy, on);
        }
    }
}

static void fb_frame(int x0, int y0, int x1, int y1)
{
    for (int x = x0; x <= x1; x++) {
        fb_pixel(x, y0, 1);
        fb_pixel(x, y1, 1);
    }
    for (int y = y0; y <= y1; y++) {
        fb_pixel(x0, y, 1);
        fb_pixel(x1, y, 1);
    }
}

static const glyph_t *glyph_for(char ch)
{
    for (size_t i = 0; i < sizeof(FONT) / sizeof(FONT[0]); i++) {
        if (FONT[i].ch == ch) {
            return &FONT[i];
        }
    }
    return NULL;   // space and anything else: blank
}

/// Draws one character with its top-left corner at (x, y); returns the next x.
static int fb_char(int x, int y, char ch, int scale)
{
    const glyph_t *g = glyph_for(ch);
    if (g) {
        for (int row = 0; row < 7; row++) {
            for (int col = 0; col < GLYPH_W; col++) {
                if (g->rows[row][col] == '#') {
                    fb_rect(x + col * scale, y + row * scale, scale, scale, 1);
                }
            }
        }
    }
    return x + ADVANCE * scale;
}

static void fb_text(int x, int y, const char *s, int scale)
{
    for (; *s; s++) {
        x = fb_char(x, y, *s, scale);
    }
}

// ------------------------------------------------------------------- SH1106
static esp_err_t oled_cmd(uint8_t c)
{
    // SH1106: every write starts with a control byte, 0x00 = the rest are commands.
    const uint8_t buf[2] = {0x00, c};
    return i2c_master_transmit(s_oled, buf, sizeof(buf), 100);
}

static esp_err_t oled_data(const uint8_t *data, size_t len)
{
    // 0x40 = the rest of the transaction is GDDRAM data. 1 + 128 bytes per page.
    uint8_t buf[1 + OLED_W];
    if (len > OLED_W) {
        return ESP_ERR_INVALID_SIZE;
    }
    buf[0] = 0x40;
    memcpy(&buf[1], data, len);
    return i2c_master_transmit(s_oled, buf, len + 1, 100);
}

static esp_err_t oled_init(void)
{
    static const uint8_t seq[] = {
        0xAE,              // display off
        0xD5, 0x80,        // clock divide / oscillator
        0xA8, 0x3F,        // multiplex: 64 rows
        0xD3, 0x00,        // display offset 0
        0x40,              // start line 0
        0xAD, 0x8B,        // DC-DC on
        0x32,              // pump voltage 8.0 V
        0xA0,              // segment remap off: RAM column 0 is the glass's left edge
        0xC0,              // COM scan upwards: RAM row 0 is the top
        0xDA, 0x12,        // COM pins: alternative, no remap
        0x81, 0x9F,        // contrast
        0xD9, 0x22,        // pre-charge
        0xDB, 0x35,        // VCOM deselect
        0xA4,              // display follows RAM
        0xA6,              // not inverted
        0xAF,              // display on
    };    for (size_t i = 0; i < sizeof(seq); i++) {
        esp_err_t err = oled_cmd(seq[i]);
        if (err != ESP_OK) {
            return err;
        }
    }
    return ESP_OK;
}

/// Paints the whole framebuffer: one page at a time, each with its own column pointer.
static esp_err_t oled_flush(void)
{
    for (int page = 0; page < OLED_H / 8; page++) {
        int col = COL_OFFSET;
        esp_err_t err = oled_cmd((uint8_t)(0xB0 | page));
        if (err == ESP_OK) {
            err = oled_cmd((uint8_t)(0x00 | (col & 0x0F)));
        }
        if (err == ESP_OK) {
            err = oled_cmd((uint8_t)(0x10 | ((col >> 4) & 0x0F)));
        }
        if (err == ESP_OK) {
            err = oled_data(s_fb[page], OLED_W);
        }
        if (err != ESP_OK) {
            return err;
        }
    }
    return ESP_OK;
}

// ---------------------------------------------------------------- the demo
static void draw_screen(unsigned seconds, unsigned tick)
{
    char line[24];

    fb_clear();
    fb_frame(0, 0, OLED_W - 1, OLED_H - 1);

    fb_text(4, 3, "ESP32-S3", 1);
    fb_text(OLED_W - 4 - 6 * ADVANCE, 3, "SH1106", 1);   // "SH1106" is 6 glyphs wide

    // Uptime in seconds, 3× so it reads from across the room: 15 px tall in a 64 px glass.
    snprintf(line, sizeof(line), "%u", seconds);
    int len = (int)strlen(line);
    int w = len * ADVANCE * 3 - 3;
    fb_text((OLED_W - w) / 2, 16, line, 3);

    fb_text(4, 42, "I2C 0x3C", 1);

    // A bar that sweeps once a second: motion is obvious even in a still screenshot.
    fb_frame(4, 53, OLED_W - 5, 59);
    int fill = (int)((OLED_W - 12) * tick / 5);
    fb_rect(6, 55, fill, 3, 1);
}

void app_main(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = 0,          // I2C0: i2c_port_num_t is a plain int in IDF 6.x
        .sda_io_num = OLED_SDA,
        .scl_io_num = OLED_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bus_cfg, &s_bus));

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = OLED_ADDR,
        .scl_speed_hz = 400000,
    };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(s_bus, &dev_cfg, &s_oled));

    esp_err_t err = i2c_master_probe(s_bus, OLED_ADDR, 100);
    if (err == ESP_OK) {
        printf("[sh1106] found a controller at 0x%02X on I2C0 (SDA %d, SCL %d)\n", OLED_ADDR, OLED_SDA, OLED_SCL);
    } else {
        printf("[sh1106] nothing at 0x%02X (%s) — add the SH1106 device on bus 0 in the launcher\n",
               OLED_ADDR, esp_err_to_name(err));
    }

    if ((err = oled_init()) == ESP_OK) {
        printf("[sh1106] initialised: 128x64, page addressed, column offset %d\n", COL_OFFSET);
    } else {
        printf("[sh1106] init failed: %s\n", esp_err_to_name(err));
    }
    ESP_LOGI(TAG, "tick %d Hz, uptime printed every second", 5);

    unsigned seconds = 0, tick = 0;
    for (;;) {
        draw_screen(seconds, tick);
        esp_err_t flush = oled_flush();
        if (flush != ESP_OK) {
            printf("[sh1106] flush failed: %s\n", esp_err_to_name(flush));
        }
        if (++tick == 5) {
            tick = 0;
            seconds++;
            printf("[sh1106] uptime %u s, %u frames\n", seconds, seconds * 5 + 1);
        }
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}
