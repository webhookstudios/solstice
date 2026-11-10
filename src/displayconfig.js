// Thin wrapper over Mutter's org.gnome.Mutter.DisplayConfig D-Bus API (GNOME 48+).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const NAME = 'org.gnome.Mutter.DisplayConfig';
const PATH = '/org/gnome/Mutter/DisplayConfig';

export const ColorMode = {DEFAULT: 0, BT2100: 1, SDR_NATIVE: 2};
export const RgbRange = {UNKNOWN: 0, AUTO: 1, FULL: 2, LIMITED: 3};

// Apply methods: VERIFY checks a config, TEMPORARY is lost on logout, PERSISTENT saves to monitors.xml.
export const Method = {VERIFY: 0, TEMPORARY: 1, PERSISTENT: 2};

const bus = Gio.DBus.session;

function call(method, params = null) {
    return bus.call_sync(NAME, PATH, NAME, method, params, null, Gio.DBusCallFlags.NONE, -1, null);
}

function getProperty(prop) {
    const r = bus.call_sync(NAME, PATH, 'org.freedesktop.DBus.Properties', 'Get',
        new GLib.Variant('(ss)', [NAME, prop]), null, Gio.DBusCallFlags.NONE, -1, null);
    return r.recursiveUnpack()[0];
}

function unpackDict(dict) {
    const out = {};
    for (const [k, v] of Object.entries(dict))
        out[k] = v instanceof GLib.Variant ? v.recursiveUnpack() : v;
    return out;
}

// Parses a mode id such as "2560x1440@143.973+vrr".
function modeInfo([id, width, height, rate, preferredScale, scales, props]) {
    const p = unpackDict(props);
    return {
        id, width, height, rate, preferredScale, scales,
        current: !!p['is-current'],
        preferred: !!p['is-preferred'],
        vrr: p['refresh-rate-mode'] === 'variable',
    };
}

// Returns a plain model of the current display state.
export function getState() {
    const [serial, monitors, logicalMonitors, props] = call('GetCurrentState').deepUnpack();
    const mons = monitors.map(([spec, modes, mprops]) => {
        const p = unpackDict(mprops);
        const [connector, vendor, product, serialNo] = spec;
        const modeList = modes.map(modeInfo);
        return {
            connector, vendor, product, serial: serialNo,
            name: p['display-name'] ?? connector,
            builtin: !!p['is-builtin'],
            modes: modeList,
            currentMode: modeList.find(m => m.current) ?? null,
            colorMode: p['color-mode'] ?? ColorMode.DEFAULT,
            supportedColorModes: p['supported-color-modes'] ?? [ColorMode.DEFAULT],
            rgbRange: p['rgb-range'] ?? RgbRange.UNKNOWN,
            underscanning: p['is-underscanning'],
            props: p,
        };
    });
    const logical = logicalMonitors.map(([x, y, scale, transform, primary, specs, lprops]) => ({
        x, y, scale, transform, primary,
        connectors: specs.map(s => s[0]),
        props: unpackDict(lprops),
    }));
    return {serial, monitors: mons, logical, props: unpackDict(props)};
}

export function supportsHdr(mon) {
    return mon.supportedColorModes.includes(ColorMode.BT2100);
}

// Applies the current layout with per-monitor overrides.
// changes: {CONNECTOR: {colorMode, rgbRange, modeId}}
export function applyChanges(changes, method = Method.TEMPORARY, state = getState()) {
    const byConnector = Object.fromEntries(state.monitors.map(m => [m.connector, m]));
    const logical = state.logical.map(lm => {
        const mons = lm.connectors.map(c => {
            const mon = byConnector[c];
            const ch = changes[c] ?? {};
            const p = {};
            const cm = ch.colorMode ?? mon.colorMode;
            if (mon.supportedColorModes.length > 1)
                p['color-mode'] = new GLib.Variant('u', cm);
            const rr = ch.rgbRange ?? mon.rgbRange;
            if (rr !== RgbRange.UNKNOWN)
                p['rgb-range'] = new GLib.Variant('u', rr);
            if (mon.underscanning !== undefined)
                p['enable_underscanning'] = new GLib.Variant('b', !!mon.underscanning);
            const modeId = ch.modeId ?? mon.currentMode?.id;
            return [c, modeId, p];
        });
        return [lm.x, lm.y, lm.scale, lm.transform, lm.primary, mons];
    });
    const props = {};
    if (state.props['layout-mode'] !== undefined)
        props['layout-mode'] = new GLib.Variant('u', state.props['layout-mode']);
    call('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
        [state.serial, method, logical, props]));
}

// A config snapshot that applyChanges() can restore.
export function snapshot(state = getState()) {
    return Object.fromEntries(state.monitors.map(m => [m.connector, {
        colorMode: m.colorMode, rgbRange: m.rgbRange, modeId: m.currentMode?.id,
    }]));
}

// HDR brightness: Mutter exposes a software "backlight" for monitors in HDR mode.
// Returns {serial, list: [{connector, active, min, max, value}]}.
export function getBacklight() {
    const [serial, list] = getProperty('Backlight');
    return {serial, list: list.map(unpackDict)};
}

export function setBacklight(connector, value) {
    const {serial, list} = getBacklight();
    const b = list.find(e => e.connector === connector);
    if (!b)
        throw new Error(`${connector} has no adjustable HDR brightness (is HDR on?)`);
    const v = Math.round(Math.min(b.max, Math.max(b.min, value)));
    call('SetBacklight', new GLib.Variant('(usi)', [serial, connector, v]));
    return v;
}

// Calls fn() whenever monitors or the backlight change. Returns a function that disconnects.
export function watch({onMonitorsChanged, onBacklightChanged}) {
    const ids = [];
    if (onMonitorsChanged)
        ids.push(bus.signal_subscribe(NAME, NAME, 'MonitorsChanged', PATH, null,
            Gio.DBusSignalFlags.NONE, () => onMonitorsChanged()));
    if (onBacklightChanged)
        ids.push(bus.signal_subscribe(NAME, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', PATH, null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _sig, params) => {
                const [, changed] = params.deepUnpack();
                if ('Backlight' in changed)
                    onBacklightChanged();
            }));
    return () => ids.forEach(id => bus.signal_unsubscribe(id));
}
