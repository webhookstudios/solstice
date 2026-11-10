// Reads what a monitor says about its own HDR abilities from its EDID (CTA-861 extension).
import GLib from 'gi://GLib';

const DRM = '/sys/class/drm';

function readEdid(connector) {
    let dir;
    try {
        dir = GLib.Dir.open(DRM, 0);
    } catch {
        return null;
    }
    let name;
    while ((name = dir.read_name()) !== null) {
        // Entries look like "card1-DP-1"; match the connector after the card prefix.
        if (!name.match(/^card\d+-/) || name.replace(/^card\d+-/, '') !== connector)
            continue;
        try {
            const [ok, bytes] = GLib.file_get_contents(`${DRM}/${name}/edid`);
            if (ok && bytes.length >= 128) {
                dir.close();
                return bytes;
            }
        } catch {}
    }
    dir.close();
    return null;
}

const maxLum = cv => 50 * 2 ** (cv / 32);

// Returns {eotfs: {sdr, hdr, pq, hlg}, maxNits, maxAvgNits, minNits, bt2020, dciP3, hdr10plus, dolbyVision}
// or null when no EDID is readable.
export function hdrInfo(connector) {
    const d = readEdid(connector);
    if (!d)
        return null;
    const info = {
        eotfs: {sdr: false, hdr: false, pq: false, hlg: false},
        maxNits: null, maxAvgNits: null, minNits: null,
        bt2020: false, dciP3: false, hdr10plus: false, dolbyVision: false,
    };
    for (let b = 128; b + 128 <= d.length; b += 128) {
        if (d[b] !== 0x02)
            continue;
        const dtdStart = d[b + 2];
        let i = b + 4;
        while (i < b + dtdStart && i < b + 127) {
            const tag = d[i] >> 5;
            const len = d[i] & 0x1f;
            const body = d.subarray(i + 1, i + 1 + len);
            if (tag === 7 && len >= 1) {
                const ext = body[0];
                if (ext === 6 && len >= 3) {
                    const e = body[1];
                    info.eotfs = {sdr: !!(e & 1), hdr: !!(e & 2), pq: !!(e & 4), hlg: !!(e & 8)};
                    if (len >= 4 && body[3])
                        info.maxNits = maxLum(body[3]);
                    if (len >= 5 && body[4])
                        info.maxAvgNits = maxLum(body[4]);
                    if (len >= 6 && info.maxNits)
                        info.minNits = info.maxNits * (body[5] / 255) ** 2 / 100;
                } else if (ext === 5 && len >= 3) {
                    info.bt2020 = !!(body[1] & 0xe0);
                    info.dciP3 = !!(body[2] & 0x80);
                } else if (ext === 1 && len >= 4) {
                    const oui = body[1] | body[2] << 8 | body[3] << 16;
                    if (oui === 0x90848b)
                        info.hdr10plus = true;
                    if (oui === 0x00d046)
                        info.dolbyVision = true;
                }
            }
            i += 1 + len;
        }
    }
    return info;
}

// A one-line summary such as "HDR10 · HLG · up to 409 nits · BT.2020".
export function summary(info) {
    if (!info)
        return 'No EDID information';
    const parts = [];
    if (info.eotfs.pq)
        parts.push(info.hdr10plus ? 'HDR10+' : 'HDR10');
    if (info.eotfs.hlg)
        parts.push('HLG');
    if (info.dolbyVision)
        parts.push('Dolby Vision');
    if (info.maxNits)
        parts.push(`up to ${Math.round(info.maxNits)} nits`);
    if (info.bt2020)
        parts.push('BT.2020');
    else if (info.dciP3)
        parts.push('DCI-P3');
    return parts.length ? parts.join(' · ') : 'No HDR metadata in EDID';
}
