// Command line: gleam on|off|toggle|brightness|status. Changes made here are saved right away.
import GLib from 'gi://GLib';

import * as DC from './displayconfig.js';
import {hdrInfo, summary} from './edid.js';
import * as Store from './store.js';

const USAGE = `Usage: gleam [COMMAND] [ARGS]

Without a command, opens the Gleam window.

Commands:
  status                       Show HDR state and brightness for each display
  on [CONNECTOR...]            Turn HDR on (all HDR displays if none given)
  off [CONNECTOR...]           Turn HDR off
  toggle [CONNECTOR...]        Turn HDR on if any target is off, otherwise off
  brightness PERCENT [CONNECTOR...]
                               Set SDR content brightness in HDR (10-210, default 100)
  restore [--once]             Re-apply remembered brightness. Gleam runs this at login;
                               it keeps watching for 20 seconds unless --once is given
  help                         Show this help

Connectors are names like DP-1 or HDMI-A-1 (see "gleam status").`;

const modeName = m => ({[DC.ColorMode.DEFAULT]: 'SDR', [DC.ColorMode.BT2100]: 'HDR',
    [DC.ColorMode.SDR_NATIVE]: 'SDR (wide gamut)'})[m] ?? `mode ${m}`;

function targets(state, names) {
    const hdr = state.monitors.filter(DC.supportsHdr);
    if (!names.length)
        return hdr;
    return names.map(n => {
        const m = state.monitors.find(x => x.connector.toLowerCase() === n.toLowerCase());
        if (!m)
            throw new Error(`No display called ${n}. Connected: ${state.monitors.map(x => x.connector).join(', ')}`);
        if (!DC.supportsHdr(m))
            throw new Error(`${m.connector} (${m.name}) does not support HDR`);
        return m;
    });
}

function status() {
    const state = DC.getState();
    const bl = DC.getBacklight().list;
    for (const m of state.monitors) {
        const b = bl.find(e => e.connector === m.connector);
        print(`${m.connector}  ${m.name}`);
        print(`  Mode:       ${modeName(m.colorMode)}${DC.supportsHdr(m) ? '' : ' (HDR not supported)'}`);
        if (m.currentMode)
            print(`  Video:      ${m.currentMode.width}x${m.currentMode.height} @ ${m.currentMode.rate.toFixed(2)} Hz${m.currentMode.vrr ? ', VRR' : ''}`);
        if (b && m.colorMode === DC.ColorMode.BT2100)
            print(`  Brightness: ${b.value}% (${b.min}-${b.max})`);
        print(`  Panel:      ${summary(hdrInfo(m.connector))}`);
    }
}

function setHdr(names, on) {
    const state = DC.getState();
    const list = targets(state, names);
    if (!list.length)
        throw new Error('No connected display supports HDR');
    const enable = on ?? list.some(m => m.colorMode !== DC.ColorMode.BT2100);
    const changes = Object.fromEntries(list.map(m => [m.connector,
        {colorMode: enable ? DC.ColorMode.BT2100 : DC.ColorMode.DEFAULT}]));
    DC.applyChanges(changes, DC.Method.PERSISTENT, state);
    print(`HDR ${enable ? 'on' : 'off'}: ${list.map(m => m.connector).join(', ')}`);
    if (enable)
        restore(list.map(m => m.connector));
}

function setBrightness(args) {
    const value = Number(args[0]);
    if (!Number.isFinite(value))
        throw new Error('brightness needs a number, for example: gleam brightness 120');
    const state = DC.getState();
    const list = targets(state, args.slice(1)).filter(m => m.colorMode === DC.ColorMode.BT2100);
    if (!list.length)
        throw new Error('HDR is off on the chosen displays. Turn it on first: gleam on');
    for (const m of list) {
        const v = DC.setBacklight(m.connector, value);
        Store.saveBrightness(m, v);
        print(`${m.connector}: brightness ${v}%`);
    }
}

// Mutter starts HDR at 100% brightness; put back what the user chose.
function restore(only = null, timeoutMs = 4000) {
    const mons = DC.getState().monitors.filter(m => !only || only.includes(m.connector));
    for (const {connector, value} of Store.restoreBrightness(mons, timeoutMs))
        print(`${connector}: brightness ${value}%`);
}

// At login GNOME can still be settling the displays, and a late mode set puts HDR brightness
// back to 100%. Keep checking for a while and re-apply whenever it drifts.
function restoreAtLogin(watchMs = 20000) {
    restore(null, 15000);
    const end = GLib.get_monotonic_time() + watchMs * 1000;
    while (GLib.get_monotonic_time() < end) {
        GLib.usleep(1000000);
        let state, list;
        try {
            state = DC.getState();
            list = DC.getBacklight().list;
        } catch {
            continue;
        }
        for (const m of state.monitors) {
            const saved = Store.savedBrightness(m);
            const b = list.find(e => e.connector === m.connector);
            if (saved === null || !b || m.colorMode !== DC.ColorMode.BT2100 || b.value === Math.round(saved))
                continue;
            try {
                print(`${m.connector}: brightness was reset to ${b.value}%, restoring ${DC.setBacklight(m.connector, saved)}%`);
            } catch {}
        }
    }
}

// Returns an exit code.
export function run(argv) {
    const [cmd, ...args] = argv;
    try {
        switch (cmd) {
        case 'status': status(); break;
        case 'on': setHdr(args, true); break;
        case 'off': setHdr(args, false); break;
        case 'toggle': setHdr(args, null); break;
        case 'brightness': setBrightness(args); break;
        case 'restore': restoreAtLogin(args[0] === '--once' ? 0 : 20000); break;
        case 'help': case '--help': case '-h': print(USAGE); break;
        default:
            printerr(`Unknown command: ${cmd}\n\n${USAGE}`);
            return 2;
        }
    } catch (e) {
        printerr(`gleam: ${e.message}`);
        return 1;
    }
    return 0;
}
