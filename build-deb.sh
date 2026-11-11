#!/bin/sh
# Builds dist/solstice_<version>_all.deb. Needs only dpkg-deb.
#
#   /usr/share/solstice/            the app's code
#   /usr/bin/solstice               launcher and command line
#   /usr/share/applications, /usr/share/icons   apps-menu entry and icon
#   /etc/xdg/autostart           re-applies saved HDR brightness at login
set -e

APP_ID=io.github.webhookstudios.Solstice
ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(cat "$ROOT/VERSION")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

install -d "$STAGE/DEBIAN" "$STAGE/usr/bin" "$STAGE/usr/share/solstice" \
    "$STAGE/usr/share/applications" \
    "$STAGE/usr/share/icons/hicolor/scalable/apps" \
    "$STAGE/usr/share/doc/solstice" \
    "$STAGE/etc/xdg/autostart"
install -m 644 "$ROOT"/src/*.js "$STAGE/usr/share/solstice/"
cp -r "$ROOT/src/sedge" "$STAGE/usr/share/solstice/"
find "$STAGE/usr/share/solstice/sedge" -type f -exec chmod 644 {} +
install -m 755 "$ROOT/bin/solstice" "$STAGE/usr/bin/solstice"
install -m 644 "$ROOT/data/$APP_ID.svg" "$STAGE/usr/share/icons/hicolor/scalable/apps/"
sed -e 's|@EXEC@|solstice|' -e "s|@ICON@|$APP_ID|" "$ROOT/data/$APP_ID.desktop.in" \
    > "$STAGE/usr/share/applications/$APP_ID.desktop"
sed -e 's|@EXEC@|solstice|' "$ROOT/data/$APP_ID.autostart.desktop.in" \
    > "$STAGE/etc/xdg/autostart/$APP_ID.autostart.desktop"
chmod 644 "$STAGE/usr/share/applications/$APP_ID.desktop" "$STAGE/etc/xdg/autostart/$APP_ID.autostart.desktop"
echo "/etc/xdg/autostart/$APP_ID.autostart.desktop" > "$STAGE/DEBIAN/conffiles"

cat > "$STAGE/usr/share/doc/solstice/copyright" <<EOT
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Solstice (formerly Gleam)
Source: https://github.com/webhookstudios/solstice

Files: *
Copyright: $(date +%Y) webhookstudios
License: GPL-2+
 On Debian systems, the full text of the GNU General Public License
 version 2 can be found in /usr/share/common-licenses/GPL-2.

Files: */sedge/fonts/*
Copyright: 2023 The Young Serif Project Authors; 2015 The Public Sans Project Authors
License: OFL-1.1
 The full license texts are in the sedge/fonts/ folder.
EOT
chmod 644 "$STAGE/usr/share/doc/solstice/copyright"

# Replaces/Breaks take over from this app's old package name, gleam.
cat > "$STAGE/DEBIAN/control" <<EOT
Package: solstice
Version: $VERSION
Architecture: all
Maintainer: webhookstudios <354619278+webhookstudios@users.noreply.github.com>
Installed-Size: $(du -sk "$STAGE/usr" | cut -f1)
Depends: gjs (>= 1.80), gir1.2-adw-1 (>= 1.5), gir1.2-gtk-4.0, gnome-shell (>= 48)
Replaces: gleam (<< 2~)
Breaks: gleam (<< 2~)
Section: gnome
Priority: optional
Homepage: https://github.com/webhookstudios/solstice
Description: HDR settings and tuning for GNOME
 Solstice (formerly Gleam) turns HDR on and off for each display and tunes how bright normal
 content looks in HDR. It also sets refresh rate, variable refresh rate,
 RGB range and wide color gamut, shows what each panel reports about its
 HDR abilities, and has a command line for keyboard shortcuts.
EOT

find "$STAGE" -type d -exec chmod 755 {} +
mkdir -p "$ROOT/dist"
dpkg-deb --root-owner-group --build "$STAGE" "$ROOT/dist/solstice_${VERSION}_all.deb"
