// ─── Deep-link schemes ────────────────────────────────────────────
//
// The app answers two URL schemes, with the same handler:
//
//   quework-desktop://   the current name. The web app switches to it once
//                        installed apps have updated to a version that
//                        registers it (v1.3.0).
//   taxone-desktop://    the original name. Kept registered so links already
//                        out there, and a web app that still emits it, keep
//                        working. Do not drop it until the web app has
//                        emitted quework-desktop:// for a full release cycle
//                        and no install older than v1.3.0 is left.
//
// Both are IDENTIFIERS, not branding: electron-builder.yml writes one
// HKCU\Software\Classes\<scheme> key per entry at install, and main.js
// re-registers both at every launch. Removing one makes every link that uses
// it do nothing, with no error.
//
// A scheme is a protocol anyone can put behind a link. Accepting a second one
// adds a second way in, not a second set of rules: every URL either scheme
// delivers goes through the same handleAuthUrl(), so the same host allowlist
// and host-change dialog apply. See ARCHITECTURE.md, "Deep-link schemes".

const PRIMARY_SCHEME = 'quework-desktop';
const LEGACY_SCHEME = 'taxone-desktop';
const PROTOCOL_SCHEMES = Object.freeze([PRIMARY_SCHEME, LEGACY_SCHEME]);

/**
 * True when `value` is a URL in one of our schemes. Windows hands the URL
 * over as typed, so the scheme is compared case-insensitively, as URL
 * parsing would.
 * @param {unknown} value
 * @returns {boolean}
 */
function isProtocolUrl(value) {
    if (typeof value !== 'string') return false;
    const lower = value.toLowerCase();
    return PROTOCOL_SCHEMES.some(scheme => lower.startsWith(`${scheme}://`));
}

/**
 * The first deep link in a second instance's command line, or undefined.
 * @param {unknown[]} commandLine
 * @returns {string|undefined}
 */
function findProtocolUrl(commandLine) {
    if (!Array.isArray(commandLine)) return undefined;
    return commandLine.find(isProtocolUrl);
}

module.exports = {
    PRIMARY_SCHEME,
    LEGACY_SCHEME,
    PROTOCOL_SCHEMES,
    isProtocolUrl,
    findProtocolUrl,
};
