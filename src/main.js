import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import * as DC from './displayconfig.js';
import {hdrInfo, summary} from './edid.js';
import * as Store from './store.js';
import {openTestPattern} from './testpattern.js';
import {applyToApp as applySedge} from './sedge/sedge.js';

const APP_ID = 'io.github.webhookstudios.Solstice';
const SEDGE_DIR = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'sedge']);
const CONFIRM_SECONDS = 15;
const RGB_RANGES = [DC.RgbRange.AUTO, DC.RgbRange.FULL, DC.RgbRange.LIMITED];

const fmtNits = n => n < 0.001 ? 'below 0.001 nits'
    : (n >= 10 ? Math.round(n) : n >= 1 ? n.toFixed(1) : n.toFixed(3)) + ' nits';
const hz = r => `${(Math.round(r * 100) / 100).toString()} Hz`;

class SolsticeWindow {
    constructor(app) {
        this.win = new Adw.ApplicationWindow({application: app, title: 'Solstice', default_width: 600, default_height: 760});
        this.toasts = new Adw.ToastOverlay();
        this.backlightRows = new Map();  // connector -> {scale, label, dragging}
        this.busy = false;  // true while a confirm dialog is open
        this.restorePending = new Set();  // connectors that just turned HDR on

        const header = new Adw.HeaderBar();
        const menu = new Gio.Menu();
        menu.append('About Solstice', 'app.about');
        header.pack_end(new Gtk.MenuButton({icon_name: 'open-menu-symbolic', menu_model: menu, tooltip_text: 'Main menu'}));
        const patternBtn = new Gtk.Button({icon_name: 'view-grid-symbolic', tooltip_text: 'Brightness test pattern'});
        patternBtn.connect('clicked', () => openTestPattern(this.win));
        header.pack_end(patternBtn);
        const refreshBtn = new Gtk.Button({icon_name: 'view-refresh-symbolic', tooltip_text: 'Reload displays'});
        refreshBtn.connect('clicked', () => this.refresh());
        header.pack_start(refreshBtn);

        this.view = new Adw.ToolbarView();
        this.view.add_top_bar(header);
        this.toasts.set_child(this.view);
        this.win.set_content(this.toasts);

        this.unwatch = DC.watch({
            onMonitorsChanged: () => this.queueRefresh(),
            onBacklightChanged: () => this.syncBacklight(),
        });
        this.win.connect('close-request', () => { this.unwatch(); return false; });
        this.refresh();
    }

    // Coalesces bursts of MonitorsChanged into one rebuild, and never rebuilds under an open dialog.
    queueRefresh(delay = 150) {
        if (this.refreshId)
            GLib.source_remove(this.refreshId);
        this.refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this.refreshId = 0;
            if (!this.busy)
                this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    toast(title) {
        this.toasts.add_toast(new Adw.Toast({title, timeout: 3}));
    }

    refresh() {
        let state;
        try {
            state = DC.getState();
        } catch (e) {
            this.view.set_content(new Adw.StatusPage({icon_name: 'dialog-error-symbolic',
                title: 'Cannot read display settings', description: `Solstice needs GNOME on Wayland.\n${e.message}`}));
            return;
        }
        this.state = state;
        this.backlightRows.clear();
        const page = new Adw.PreferencesPage();
        const hdrMonitors = state.monitors.filter(DC.supportsHdr);

        if (!hdrMonitors.length) {
            const g = new Adw.PreferencesGroup();
            g.add(new Adw.ActionRow({title: 'No HDR display found',
                subtitle: 'None of the connected displays offer HDR over this connection. ' +
                    'Check that HDR is enabled in the monitor’s own menu and that the cable supports it.'}));
            page.add(g);
        }
        if (hdrMonitors.length > 1)
            page.add(this.allGroup(hdrMonitors));
        for (const mon of state.monitors)
            page.add(this.monitorGroup(mon));

        this.view.set_content(page);
        this.syncBacklight();
    }

    allGroup(list) {
        const g = new Adw.PreferencesGroup();
        const on = list.every(m => m.colorMode === DC.ColorMode.BT2100);
        const row = new Adw.SwitchRow({title: 'HDR on all displays', subtitle: list.map(m => m.connector).join(', '), active: on});
        row.connect('notify::active', () => {
            const cm = row.active ? DC.ColorMode.BT2100 : DC.ColorMode.DEFAULT;
            this.applyWithConfirm(Object.fromEntries(list.map(m => [m.connector, {colorMode: cm}])));
        });
        g.add(row);
        return g;
    }

    monitorGroup(mon) {
        const info = hdrInfo(mon.connector);
        const supportsHdr = DC.supportsHdr(mon);
        const hdrOn = mon.colorMode === DC.ColorMode.BT2100;
        const g = new Adw.PreferencesGroup({
            title: GLib.markup_escape_text(mon.name, -1),
            description: `${mon.connector} · ${summary(info)}`,
        });

        // HDR
        const hdrRow = new Adw.SwitchRow({
            title: 'HDR',
            subtitle: supportsHdr ? 'High dynamic range (BT.2100 PQ)' : 'Not available on this display or connection',
            active: hdrOn, sensitive: supportsHdr,
        });
        hdrRow.connect('notify::active', () =>
            this.applyWithConfirm({[mon.connector]: {colorMode: hdrRow.active ? DC.ColorMode.BT2100 : DC.ColorMode.DEFAULT}}));
        g.add(hdrRow);

        // SDR content brightness (only while HDR is on)
        if (hdrOn)
            g.add(this.brightnessRow(mon));

        // Wide gamut SDR
        if (!hdrOn && mon.supportedColorModes.includes(DC.ColorMode.SDR_NATIVE)) {
            const wide = new Adw.SwitchRow({
                title: 'Wide color gamut',
                subtitle: 'Use the panel’s full native colors in SDR. Colors look more saturated',
                active: mon.colorMode === DC.ColorMode.SDR_NATIVE,
            });
            wide.connect('notify::active', () =>
                this.applyWithConfirm({[mon.connector]: {colorMode: wide.active ? DC.ColorMode.SDR_NATIVE : DC.ColorMode.DEFAULT}}));
            g.add(wide);
        }

        // Refresh rate and VRR, for the current resolution
        const cur = mon.currentMode;
        if (cur) {
            const sameRes = mon.modes.filter(m => m.width === cur.width && m.height === cur.height);
            const fixed = sameRes.filter(m => !m.vrr).sort((a, b) => b.rate - a.rate);
            const pick = (rate, vrr) => sameRes.find(m => Math.abs(m.rate - rate) < 0.01 && m.vrr === vrr);
            if (fixed.length > 1) {
                const rateRow = new Adw.ComboRow({title: 'Refresh rate', subtitle: `${cur.width}×${cur.height}`,
                    model: Gtk.StringList.new(fixed.map(m => hz(m.rate)))});
                rateRow.selected = Math.max(0, fixed.findIndex(m => Math.abs(m.rate - cur.rate) < 0.01));
                rateRow.connect('notify::selected', () => {
                    const target = pick(fixed[rateRow.selected].rate, cur.vrr) ?? fixed[rateRow.selected];
                    if (target.id !== cur.id)
                        this.applyWithConfirm({[mon.connector]: {modeId: target.id}});
                });
                g.add(rateRow);
            }
            if (pick(cur.rate, !cur.vrr)) {
                const vrrRow = new Adw.SwitchRow({title: 'Variable refresh rate',
                    subtitle: 'Matches refresh to games and video. Some monitors flicker with VRR in HDR',
                    active: cur.vrr});
                vrrRow.connect('notify::active', () =>
                    this.applyWithConfirm({[mon.connector]: {modeId: pick(cur.rate, vrrRow.active).id}}));
                g.add(vrrRow);
            }
        }

        // RGB range
        if (mon.rgbRange !== DC.RgbRange.UNKNOWN) {
            const rgbRow = new Adw.ComboRow({title: 'RGB range',
                subtitle: 'Use Full for PC monitors. Limited can fix crushed blacks on TVs',
                model: Gtk.StringList.new(['Automatic', 'Full', 'Limited'])});
            rgbRow.selected = Math.max(0, RGB_RANGES.indexOf(mon.rgbRange));
            rgbRow.connect('notify::selected', () =>
                this.applyWithConfirm({[mon.connector]: {rgbRange: RGB_RANGES[rgbRow.selected]}}));
            g.add(rgbRow);
        }

        // Panel details from EDID
        if (info) {
            const ex = new Adw.ExpanderRow({title: 'Panel details', subtitle: 'What the monitor reports about itself'});
            const add = (title, value) => {
                const r = new Adw.ActionRow({title, subtitle: value, subtitle_selectable: true});
                r.add_css_class('property');
                ex.add_row(r);
            };
            const eotf = [info.eotfs.sdr && 'SDR', info.eotfs.pq && 'PQ (HDR10)', info.eotfs.hlg && 'HLG'].filter(Boolean);
            add('Transfer functions', eotf.join(', ') || 'Not reported');
            add('Peak brightness', info.maxNits ? fmtNits(info.maxNits) : 'Not reported');
            add('Full-screen brightness', info.maxAvgNits ? fmtNits(info.maxAvgNits) : 'Not reported');
            add('Black level', info.minNits ? fmtNits(info.minNits) : 'Not reported');
            const spaces = ['sRGB', info.dciP3 && 'DCI-P3', info.bt2020 && 'BT.2020'].filter(Boolean);
            add('Color spaces', spaces.join(', '));
            if (info.hdr10plus || info.dolbyVision)
                add('Dynamic metadata', [info.hdr10plus && 'HDR10+', info.dolbyVision && 'Dolby Vision'].filter(Boolean).join(', '));
            g.add(ex);
        }
        return g;
    }

    brightnessRow(mon) {
        const row = new Adw.ActionRow({title: 'SDR content brightness',
            subtitle: 'How bright windows and normal content look in HDR'});
        const adj = new Gtk.Adjustment({lower: 10, upper: 210, step_increment: 1, page_increment: 10, value: 100});
        const scale = new Gtk.Scale({adjustment: adj, draw_value: false, hexpand: true, width_request: 200, valign: Gtk.Align.CENTER});
        scale.add_mark(100, Gtk.PositionType.BOTTOM, null);
        const label = new Gtk.Label({width_chars: 5, xalign: 1, css_classes: ['numeric']});
        const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', tooltip_text: 'Reset to 100%',
            valign: Gtk.Align.CENTER, css_classes: ['flat']});
        row.add_suffix(scale);
        row.add_suffix(label);
        row.add_suffix(reset);

        const entry = {scale, label, syncing: false, pending: null, timer: 0};
        const push = () => {
            entry.timer = 0;
            if (entry.pending === null)
                return GLib.SOURCE_REMOVE;
            try {
                Store.saveBrightness(mon, DC.setBacklight(mon.connector, entry.pending));
            } catch (e) {
                this.toast(e.message);
            }
            entry.pending = null;
            return GLib.SOURCE_REMOVE;
        };
        adj.connect('value-changed', () => {
            label.label = `${Math.round(adj.value)}%`;
            if (entry.syncing)
                return;
            entry.pending = adj.value;
            if (!entry.timer)  // throttle D-Bus calls while dragging
                entry.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, push);
        });
        reset.connect('clicked', () => adj.set_value(100));
        label.label = `${Math.round(adj.value)}%`;
        this.backlightRows.set(mon.connector, entry);
        return row;
    }

    syncBacklight() {
        let list;
        try {
            list = DC.getBacklight().list;
        } catch {
            return;
        }
        for (const [connector, entry] of this.backlightRows) {
            const b = list.find(e => e.connector === connector);
            if (!b || entry.pending !== null)
                continue;
            if (this.restorePending.delete(connector)) {
                const mon = this.state.monitors.find(m => m.connector === connector);
                const saved = mon && Store.savedBrightness(mon);
                if (saved !== null && saved !== b.value) {
                    try {
                        b.value = DC.setBacklight(connector, saved);
                    } catch {}
                }
            }
            entry.syncing = true;
            entry.scale.adjustment.lower = b.min;
            entry.scale.adjustment.upper = b.max;
            entry.scale.adjustment.value = b.value;
            entry.syncing = false;
        }
    }

    // Applies a change for now, then asks the user to keep it. Reverts if they don't answer.
    applyWithConfirm(changes) {
        if (this.busy)
            return;
        // Always start from Mutter's live state: another tool may have changed it since we drew the page.
        let live;
        try {
            live = DC.getState();
        } catch (e) {
            this.toast(e.message);
            return;
        }
        const before = DC.snapshot(live);
        changes = Object.fromEntries(Object.entries(changes).map(([c, ch]) => [c,
            Object.fromEntries(Object.entries(ch).filter(([k, v]) => before[c] && before[c][k] !== v))])
            .filter(([, ch]) => Object.keys(ch).length));
        if (!Object.keys(changes).length) {
            this.refresh();  // the page was out of date; nothing to apply
            return;
        }
        try {
            DC.applyChanges(changes, DC.Method.TEMPORARY, live);
        } catch (e) {
            this.toast(`Could not apply: ${e.message.replace(/^GDBus\.Error:[^ ]+ /, '')}`);
            this.refresh();
            return;
        }
        this.busy = true;
        let left = CONFIRM_SECONDS;
        const body = () => `The display settings will be reverted in ${left} second${left === 1 ? '' : 's'}.`;
        const dialog = new Adw.AlertDialog({heading: 'Keep these display settings?', body: body(),
            close_response: 'revert', default_response: 'keep'});
        dialog.add_response('revert', 'Revert');
        dialog.add_response('keep', 'Keep changes');
        dialog.set_response_appearance('keep', Adw.ResponseAppearance.SUGGESTED);
        const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            left--;
            if (left <= 0) {
                dialog.close();  // emits the close response ("revert")
                return GLib.SOURCE_REMOVE;
            }
            dialog.body = body();
            return GLib.SOURCE_CONTINUE;
        });
        dialog.connect('response', (_d, response) => {
            GLib.source_remove(timer);
            const final = response === 'keep' ? changes : Object.fromEntries(Object.keys(changes).map(c => [c, before[c]]));
            try {
                DC.applyChanges(final, DC.Method.PERSISTENT);
            } catch (e) {
                this.toast(e.message);
            }
            // A mode set resets HDR brightness to 100%; put the remembered value back.
            for (const c of Object.keys(changes)) {
                const cm = final[c]?.colorMode ?? before[c]?.colorMode;
                if (cm === DC.ColorMode.BT2100)
                    this.restorePending.add(c);
            }
            this.busy = false;
            // Mutter needs a moment to settle the new mode before brightness controls appear.
            this.queueRefresh(300);
            if (response !== 'keep')
                this.toast('Display settings reverted');
        });
        dialog.present(this.win);
    }
}

export function main(argv = []) {
    const app = new Adw.Application({application_id: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
    app.connect('startup', () => applySedge(SEDGE_DIR));
    const about = new Gio.SimpleAction({name: 'about'});
    about.connect('activate', () => new Adw.AboutDialog({
        application_name: 'Solstice', application_icon: APP_ID, developer_name: 'webhookstudios',
        website: 'https://github.com/webhookstudios/solstice', license_type: Gtk.License.GPL_2_0,
        comments: 'HDR on and off for each display, and how bright normal content looks.\n\nPart of the Sedge family of apps.',
    }).present(app.active_window));
    app.add_action(about);
    app.connect('activate', () => {
        if (!app.active_window)
            app.window = new SolsticeWindow(app);
        app.active_window.present();
    });
    return app.runAsync(['solstice', ...argv]);
}
