#!/bin/sh
# Installs Gleam for the current user, without root. Run ./install.sh --uninstall to remove it.
set -e

APP_ID=io.github.webhookstudios.Gleam
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
DEST="$DATA/gleam/app"
BIN="$HOME/.local/bin/gleam"

if [ "$1" = "--uninstall" ]; then
    rm -rf "$DATA/gleam" "$BIN" \
        "$DATA/applications/$APP_ID.desktop" \
        "$DATA/icons/hicolor/scalable/apps/$APP_ID.svg" \
        "$CONFIG/autostart/$APP_ID.autostart.desktop"
    update-desktop-database "$DATA/applications" 2>/dev/null || true
    echo "Gleam is removed. Your saved brightness in $CONFIG/gleam was kept."
    exit 0
fi

mkdir -p "$DEST" "$DATA/applications" "$DATA/icons/hicolor/scalable/apps" "$CONFIG/autostart" "$(dirname "$BIN")"
rm -rf "$DEST"/*
cp "$ROOT"/src/*.js "$DEST/"
cp "$ROOT/bin/gleam" "$DEST/launcher.js"

# A small wrapper so "gleam on", "gleam off" etc. work in a terminal or a keyboard shortcut.
cat > "$BIN" <<EOT
#!/bin/sh
GLEAM_DIR="$DEST" exec gjs -m "$DEST/launcher.js" "\$@"
EOT
chmod 755 "$BIN"

cp "$ROOT/data/$APP_ID.svg" "$DATA/icons/hicolor/scalable/apps/"
ICON="$DATA/icons/hicolor/scalable/apps/$APP_ID.svg"
sed -e "s|@EXEC@|$BIN|" -e "s|@ICON@|$ICON|" \
    "$ROOT/data/$APP_ID.desktop.in" > "$DATA/applications/$APP_ID.desktop"
sed -e "s|@EXEC@|$BIN|" \
    "$ROOT/data/$APP_ID.autostart.desktop.in" > "$CONFIG/autostart/$APP_ID.autostart.desktop"
update-desktop-database "$DATA/applications" 2>/dev/null || true

echo "Gleam is installed. Open it from the apps menu, or run: gleam status"
case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "Note: $HOME/.local/bin is not on your PATH yet; log out and back in, or use $BIN." ;;
esac
