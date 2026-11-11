#!/bin/sh
# Installs Solstice for the current user, without root. Run ./install.sh --uninstall to remove it.
set -e

APP_ID=io.github.webhookstudios.Solstice
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
DEST="$DATA/solstice/app"
BIN="$HOME/.local/bin/solstice"

if [ "$1" = "--uninstall" ]; then
    rm -rf "$DATA/solstice" "$BIN" \
        "$DATA/applications/$APP_ID.desktop" \
        "$DATA/icons/hicolor/scalable/apps/$APP_ID.svg" \
        "$CONFIG/autostart/$APP_ID.autostart.desktop"
    update-desktop-database "$DATA/applications" 2>/dev/null || true
    echo "Solstice is removed. Your saved brightness in $CONFIG/solstice was kept."
    exit 0
fi

mkdir -p "$DEST" "$DATA/applications" "$DATA/icons/hicolor/scalable/apps" "$CONFIG/autostart" "$(dirname "$BIN")"
rm -rf "$DEST"/*
cp "$ROOT"/src/*.js "$DEST/"
cp "$ROOT/bin/solstice" "$DEST/launcher.js"

# A small wrapper so "solstice on", "solstice off" etc. work in a terminal or a keyboard shortcut.
cat > "$BIN" <<EOT
#!/bin/sh
SOLSTICE_DIR="$DEST" exec gjs -m "$DEST/launcher.js" "\$@"
EOT
chmod 755 "$BIN"

cp "$ROOT/data/$APP_ID.svg" "$DATA/icons/hicolor/scalable/apps/"
ICON="$DATA/icons/hicolor/scalable/apps/$APP_ID.svg"
sed -e "s|@EXEC@|$BIN|" -e "s|@ICON@|$ICON|" \
    "$ROOT/data/$APP_ID.desktop.in" > "$DATA/applications/$APP_ID.desktop"
sed -e "s|@EXEC@|$BIN|" \
    "$ROOT/data/$APP_ID.autostart.desktop.in" > "$CONFIG/autostart/$APP_ID.autostart.desktop"
update-desktop-database "$DATA/applications" 2>/dev/null || true

echo "Solstice is installed. Open it from the apps menu, or run: solstice status"
case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "Note: $HOME/.local/bin is not on your PATH yet; log out and back in, or use $BIN." ;;
esac
