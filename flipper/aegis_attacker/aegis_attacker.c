#include <furi.h>
#include <furi_hal.h>
#include <furi_hal_gpio.h>
#include <furi_hal_resources.h>
#include <gui/gui.h>
#include <input/input.h>

#define ATTACK_PIN (&gpio_ext_pa7) // Flipper external pin 2

typedef enum {
    AttackModeOff = 0,
    AttackModeSpoof,
    AttackModeNoise,
    AttackModeCount,
} AttackMode;

typedef struct {
    AttackMode mode;
    uint16_t pulse_period_us;
    uint32_t shots;
    FuriMutex* mutex;
} AppState;

typedef struct {
    FuriMessageQueue* queue;
} AppCtx;

static const char* mode_label(AttackMode m) {
    switch(m) {
    case AttackModeOff: return "OFF";
    case AttackModeSpoof: return "SPOOF (HIGH)";
    case AttackModeNoise: return "NOISE (PULSE)";
    default: return "?";
    }
}

static void draw_callback(Canvas* canvas, void* ctx) {
    AppState* s = ctx;
    furi_mutex_acquire(s->mutex, FuriWaitForever);

    canvas_clear(canvas);
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str(canvas, 2, 11, "Aegis Attacker");
    canvas_draw_line(canvas, 0, 13, 128, 13);

    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str(canvas, 2, 25, "Mode:");
    canvas_draw_str(canvas, 32, 25, mode_label(s->mode));

    char buf[32];
    if(s->mode == AttackModeNoise) {
        snprintf(buf, sizeof(buf), "Period: %u us", s->pulse_period_us);
        canvas_draw_str(canvas, 2, 36, buf);
    } else {
        canvas_draw_str(canvas, 2, 36, "Pin: PA7 (ext. P2)");
    }

    snprintf(buf, sizeof(buf), "Shots: %lu", (unsigned long)s->shots);
    canvas_draw_str(canvas, 2, 47, buf);

    canvas_draw_str(canvas, 2, 62, "OK:cycle  Up/Dn:rate");

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
    switch(s->mode) {
    case AttackModeOff:
        set_pin_safe();
        break;
    case AttackModeSpoof:
        furi_hal_gpio_init(ATTACK_PIN, GpioModeOutputPushPull, GpioPullNo, GpioSpeedLow);
        furi_hal_gpio_write(ATTACK_PIN, true);
        break;
    case AttackModeNoise:
        furi_hal_gpio_init(ATTACK_PIN, GpioModeOutputPushPull, GpioPullNo, GpioSpeedHigh);
        furi_hal_gpio_write(ATTACK_PIN, false);
        break;
    default:
        break;
    }
}

int32_t aegis_attacker_app(void* p) {
    UNUSED(p);

    AppState state = {
        .mode = AttackModeOff,
        .pulse_period_us = 200, // ~5 kHz square wave
        .shots = 0,
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
    bool pulse_level = false;

    while(running) {
        uint32_t timeout = (state.mode == AttackModeNoise) ? 0 : 100;
        FuriStatus status = furi_message_queue_get(ctx.queue, &event, timeout);

        if(status == FuriStatusOk) {
            if(event.type == InputTypeShort || event.type == InputTypeRepeat) {
                furi_mutex_acquire(state.mutex, FuriWaitForever);
                switch(event.key) {
                case InputKeyOk:
                    state.mode = (state.mode + 1) % AttackModeCount;
                    apply_mode(&state);
                    state.shots = 0;
                    break;
                case InputKeyUp:
                    if(state.pulse_period_us > 20) state.pulse_period_us -= 20;
                    break;
                case InputKeyDown:
                    if(state.pulse_period_us < 5000) state.pulse_period_us += 20;
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
        }

        if(state.mode == AttackModeNoise) {
            pulse_level = !pulse_level;
            furi_hal_gpio_write(ATTACK_PIN, pulse_level);
            furi_delay_us(state.pulse_period_us / 2);
            state.shots++;
            if((state.shots & 0x3FF) == 0) view_port_update(view_port);
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
