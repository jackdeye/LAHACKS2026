// Aegis Edge — Flipper-side IR fault injector.
//
// Beams a 38 kHz NEC IR heartbeat (addr 0x00, cmd 0x42) at the Arduino's
// IR receiver while ATTACKING. The receiver-side firmware treats the
// heartbeat as a "broken sensor" trigger and starts publishing NaN for
// temp_c, which fires the vent's safety alarm. No wiring required —
// line-of-sight only, aim the Flipper's top edge at the IR receiver.

#include <furi.h>
#include <furi_hal.h>
#include <gui/gui.h>
#include <input/input.h>
#include <infrared.h>
#include <infrared_transmit.h>

#define AEGIS_IR_ADDR     0x00
#define AEGIS_IR_CMD      0x42
// Arduino timeout is 2000 ms — 80 ms cadence (just above the ~68 ms NEC
// frame TX time) gives the receiver ~25 chances to catch a single frame
// per timeout window. Bias is heavily toward false positives.
#define HEARTBEAT_MS      80

static const InfraredMessage k_attack_message = {
    .protocol = InfraredProtocolNEC,
    .address = AEGIS_IR_ADDR,
    .command = AEGIS_IR_CMD,
    .repeat = false,
};

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

    /* --- top bar --- */
    canvas_draw_box(canvas, 0, 0, 128, 13);
    /* thin separator under the bar for a layered look */
    canvas_draw_line(canvas, 0, 14, 127, 14);
    canvas_set_color(canvas, ColorWhite);

    canvas_set_font(canvas, FontPrimary);
    const char* title = "FAULT INJECTOR";
    uint16_t tw = canvas_string_width(canvas, title);
    int tx = (128 - (int)tw) / 2;
    canvas_draw_str(canvas, tx, 10, title);

    /* tick accents flanking the title */
    canvas_draw_line(canvas, tx - 4, 4, tx - 4, 9);
    canvas_draw_line(canvas, tx + tw + 3, 4, tx + tw + 3, 9);

    /* status pip in the corner: solid when armed, blinking when idle */
    if(s->attacking) {
        canvas_draw_box(canvas, 121, 4, 5, 5);
    } else if(fast_blink) {
        canvas_draw_frame(canvas, 121, 4, 5, 5);
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

    /* --- action prompt --- */
    canvas_set_font(canvas, FontSecondary);
    if(s->attacking) {
        draw_centered_str(canvas, 58, "Press OK to disengage");
    } else {
        draw_centered_str(canvas, 58, "Press OK to engage");
    }

    furi_mutex_release(s->mutex);
}

static void input_callback(InputEvent* event, void* ctx) {
    AppCtx* c = ctx;
    furi_message_queue_put(c->queue, event, FuriWaitForever);
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

    InputEvent event;
    bool running = true;
    uint32_t last_redraw = 0;
    uint32_t last_tx = 0;

    while(running) {
        // Short queue wait so we can service the IR heartbeat between events.
        FuriStatus status = furi_message_queue_get(ctx.queue, &event, 25);

        if(status == FuriStatusOk && event.type == InputTypeShort) {
            furi_mutex_acquire(state.mutex, FuriWaitForever);
            switch(event.key) {
            case InputKeyOk:
                state.attacking = !state.attacking;
                state.since_tick = furi_get_tick();
                if(state.attacking) {
                    // Fire the first frame immediately so the target reacts
                    // without waiting up to a full HEARTBEAT_MS.
                    infrared_send(&k_attack_message, 1);
                    last_tx = furi_get_tick();
                }
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

        uint32_t now = furi_get_tick();

        bool attacking_now;
        furi_mutex_acquire(state.mutex, FuriWaitForever);
        attacking_now = state.attacking;
        furi_mutex_release(state.mutex);

        if(attacking_now && (now - last_tx) >= HEARTBEAT_MS) {
            infrared_send(&k_attack_message, 1);
            last_tx = furi_get_tick();
        }

        /* keep the blink animation alive */
        if(now - last_redraw >= 200) {
            last_redraw = now;
            view_port_update(view_port);
        }
    }

    view_port_enabled_set(view_port, false);
    gui_remove_view_port(gui, view_port);
    view_port_free(view_port);
    furi_message_queue_free(ctx.queue);
    furi_record_close(RECORD_GUI);
    furi_mutex_free(state.mutex);

    return 0;
}
