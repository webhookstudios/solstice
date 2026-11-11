// A gray-step pattern for tuning SDR content brightness while HDR is on.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

const ROWS = [
    {title: 'Near black: 1% should be just visible against 0%', steps: [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15]},
    {title: 'Gray ramp', steps: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]},
    {title: 'Near white: 98% and 100% should still look different', steps: [85, 88, 90, 92, 94, 95, 96, 97, 98, 99, 100]},
];

function draw(_area, cr, width, height) {
    cr.setSourceRGB(0, 0, 0);
    cr.paint();
    const pad = Math.max(16, width * 0.03);
    const rowH = (height - pad * 2) / ROWS.length;
    cr.selectFontFace('Sans', 0, 0);
    ROWS.forEach((row, r) => {
        const top = pad + r * rowH;
        const textH = Math.min(22, rowH * 0.12);
        cr.setFontSize(textH * 0.8);
        cr.setSourceRGB(0.55, 0.55, 0.55);
        cr.moveTo(pad, top + textH);
        cr.showText(row.title);
        const n = row.steps.length;
        const w = (width - pad * 2) / n;
        const boxTop = top + textH * 1.6;
        const boxH = rowH - textH * 2.6;
        row.steps.forEach((pct, i) => {
            const v = Math.round(pct * 2.55) / 255;  // 8-bit code value
            cr.setSourceRGB(v, v, v);
            cr.rectangle(pad + i * w, boxTop, w, boxH);
            cr.fill();
            const ink = v > 0.4 ? 0 : 0.6;  // dark labels on light patches
            cr.setSourceRGB(ink, ink, ink);
            cr.setFontSize(textH * 0.7);
            cr.moveTo(pad + i * w + 6, boxTop + boxH - 8);
            cr.showText(`${pct}%`);
        });
    });
    cr.$dispose();
}

export function openTestPattern(parent) {
    const win = new Adw.Window({title: 'Solstice test pattern', default_width: 1100, default_height: 640, transient_for: null});
    const area = new Gtk.DrawingArea({hexpand: true, vexpand: true});
    area.set_draw_func(draw);

    const header = new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title: 'Test pattern',
        subtitle: 'Drag to the HDR display · F11 or double-click for full screen · Esc to close'})});
    const view = new Adw.ToolbarView({content: area});
    view.add_top_bar(header);
    win.set_content(view);

    const toggleFs = () => {
        if (win.is_fullscreen()) {
            win.unfullscreen();
            view.reveal_top_bars = true;
        } else {
            win.fullscreen();
            view.reveal_top_bars = false;
        }
    };
    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_c, keyval) => {
        if (keyval === Gdk.KEY_Escape) {
            if (win.is_fullscreen())
                toggleFs();
            else
                win.close();
            return true;
        }
        if (keyval === Gdk.KEY_F11 || keyval === Gdk.KEY_f) {
            toggleFs();
            return true;
        }
        return false;
    });
    win.add_controller(keys);
    const click = new Gtk.GestureClick();
    click.connect('pressed', (_g, n) => { if (n === 2) toggleFs(); });
    area.add_controller(click);

    win.set_application(parent.application);
    win.present();
}
