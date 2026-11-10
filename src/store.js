// Remembers HDR brightness per monitor. Mutter resets it to 100% whenever HDR turns on or at login.
import GLib from 'gi://GLib';

import * as DC from './displayconfig.js';

const DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'gleam']);
const FILE = GLib.build_filenamev([DIR, 'settings.json']);

// Identify the monitor itself, not the port, so it survives moving cables.
const key = mon => [mon.vendor, mon.product, mon.serial].join('|') || mon.connector;

function load() {
    try {
        const [, bytes] = GLib.file_get_contents(FILE);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return {brightness: {}};
    }
}

function save(data) {
    GLib.mkdir_with_parents(DIR, 0o755);
    GLib.file_set_contents(FILE, JSON.stringify(data, null, 2));
}

export function savedBrightness(mon) {
    return load().brightness?.[key(mon)] ?? null;
}

export function saveBrightness(mon, value) {
    const data = load();
    data.brightness ??= {};
    data.brightness[key(mon)] = Math.round(value);
    save(data);
}

// Waits (blocking) until Mutter offers HDR brightness for these connectors. Returns the ones that appeared.
export function waitForBacklight(connectors, timeoutMs = 4000) {
    const end = GLib.get_monotonic_time() + timeoutMs * 1000;
    for (;;) {
        let have = [];
        try {
            have = DC.getBacklight().list.map(b => b.connector);
        } catch {}
        const ready = connectors.filter(c => have.includes(c));
        if (ready.length === connectors.length || GLib.get_monotonic_time() > end)
            return ready;
        GLib.usleep(100000);
    }
}

// Re-applies remembered brightness on monitors that are in HDR. Returns [{connector, value}].
export function restoreBrightness(monitors, timeoutMs = 4000) {
    const hdr = monitors.filter(m => m.colorMode === DC.ColorMode.BT2100 && savedBrightness(m) !== null);
    if (!hdr.length)
        return [];
    const ready = waitForBacklight(hdr.map(m => m.connector), timeoutMs);
    const done = [];
    for (const m of hdr.filter(x => ready.includes(x.connector))) {
        try {
            done.push({connector: m.connector, value: DC.setBacklight(m.connector, savedBrightness(m))});
        } catch {}
    }
    return done;
}
