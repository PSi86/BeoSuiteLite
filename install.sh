#!/usr/bin/env bash
#
# BeoSuiteLite installer
# =======================
# Automates the SOFTWARE setup of this project on a fresh Raspberry Pi OS Lite
# (64-bit) for a HiFiBerry Beocreate 4-Channel Amplifier.
#
# Run ON the Pi, from a clone of this repository, as a sudo-capable user:
#
#     git clone https://github.com/PSi86/BeoSuiteLite
#     cd BeoSuiteLite
#     sudo ./install.sh
#
# What it does NOT do (hardware / interactive — printed as next steps at the end):
#   * flash the DSP program to the board EEPROM (needs the physical J1 jumper),
#   * wire up speakers / optical cable.
#
# Sub-commands (run after the base install + a reboot):
#   sudo ./install.sh flash-dsp     # flash the DSP profile (run with J1 REMOVED)
#   sudo ./install.sh safe-volume   # set a safe low DSPVolume and persist it
#
# NOTE: derived from a known-working setup; review before running. Volume safety
# is baked in (the first stored DSPVolume is deliberately low). This talks to real
# audio hardware at full amplifier power — keep the volume low on first sound.

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
GLR_VERSION="v0.7.4"
DSP_PROFILE="beocreate-universal-11.xml"
SAFE_VOLUME_PCT="40"
DSP_CHECKSUM_EXPECTED="97C9C5A88582888D111259BF70D6D79E"
DSP_REST="http://127.0.0.1:13141"   # sigmatcpserver --enable-rest

# --- helpers ---------------------------------------------------------------
log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "Please run with sudo (as root)."; }

append_line_once() { # append_line_once <line> <file>
	local line="$1" file="$2"
	grep -qxF -- "$line" "$file" 2>/dev/null || printf '%s\n' "$line" >> "$file"
}

# Reads the DSP program checksum via the sigmatcpserver REST API.
# Echoes the checksum (uppercase hex) or nothing if it can't be read.
dsp_checksum() {
	curl -s -m5 "$DSP_REST/checksum" 2>/dev/null \
		| grep -oE '"checksum":"[0-9A-Fa-f]+"' | head -1 | sed 's/.*:"//; s/"//'
}

# Target user for go-librespot (the non-root user that ran sudo; falls back to pi).
TARGET_USER="${SUDO_USER:-pi}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6 || true)"
[ -n "${TARGET_HOME:-}" ] || TARGET_HOME="/home/$TARGET_USER"

preflight() {
	need_root
	[ "$(uname -m)" = "aarch64" ] || warn "Architecture is $(uname -m), expected aarch64 — the go-librespot binary is arm64."
	[ -f /boot/firmware/config.txt ] || die "/boot/firmware/config.txt not found — is this Raspberry Pi OS (Bookworm/Trixie)?"
	[ -d "$REPO/deploy" ] || die "deploy/ not found next to this script — run it from a clone of the repo."
	command -v curl >/dev/null || true
}

# --- phase 0: base packages + boot config ----------------------------------
phase_base() {
	log "Phase 0/5 — base packages and boot config"
	apt-get update -y
	apt-get install -y git curl ca-certificates alsa-utils nodejs npm avahi-daemon avahi-utils

	local cfg=/boot/firmware/config.txt
	info "Enabling HiFiBerry DAC + SPI/I2S/I2C in $cfg"
	append_line_once "dtparam=audio=off"        "$cfg"
	append_line_once "dtoverlay=hifiberry-dac"  "$cfg"
	append_line_once "dtparam=i2s=on"           "$cfg"
	append_line_once "dtparam=spi=on"           "$cfg"
	append_line_once "dtparam=i2c_arm=on"       "$cfg"

	info "spidev buffer for large DSP reads (needed for (re)flashing)"
	install -m0644 "$REPO/deploy/etc-modprobe.d/spidev.conf" /etc/modprobe.d/spidev.conf
	if ! grep -q "spidev.bufsiz" /boot/firmware/cmdline.txt; then
		cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak
		sed -i '1 s/$/ spidev.bufsiz=131072/' /boot/firmware/cmdline.txt
	fi
}

# --- phase 1: hifiberry-dsp (sigmatcpserver) --------------------------------
phase_dsp_backend() {
	log "Phase 1/5 — hifiberry-dsp (sigmatcpserver)"
	local codename; codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-trixie}")"
	install -m0644 "$REPO/deploy/hifiberry/hifiberry-archive-keyring.gpg" /usr/share/keyrings/hifiberry-archive-keyring.gpg
	echo "deb [signed-by=/usr/share/keyrings/hifiberry-archive-keyring.gpg] http://debianrepo.hifiberry.com ${codename} main" \
		> /etc/apt/sources.list.d/hifiberry.list
	apt-get update -y
	apt-get install -y hifiberry-dsp

	info "sigmatcpserver override: enable SigmaTCP :8086 + DSPVolume (--alsa --enable-rest)"
	install -d /etc/systemd/system/sigmatcpserver.service.d
	install -m0644 "$REPO/deploy/systemd/sigmatcpserver.service.d/override.conf" \
		/etc/systemd/system/sigmatcpserver.service.d/override.conf
	systemctl daemon-reload
	systemctl enable sigmatcpserver.service
}

# --- phase 2: Beocreate 2 UI + our extensions/configs -----------------------
phase_beocreate() {
	log "Phase 2/5 — Beocreate 2 UI"
	local src=/tmp/beocreate-create
	rm -rf "$src"
	info "Cloning bang-olufsen/create (upstream Beocreate 2, frozen)"
	git clone --depth 1 https://github.com/bang-olufsen/create "$src"

	install -d /opt/beocreate
	cp -a "$src"/Beocreate2/. /opt/beocreate/
	cp -a "$src"/beocreate_essentials /opt/beocreate/beocreate_essentials

	info "npm dependencies (+ Express 4 pin; Express 5 crashes beo-server)"
	( cd /opt/beocreate/beo-system && npm install --no-audit --no-fund \
		&& npm install --no-audit --no-fund express@^4.18 node-fetch@2 )

	info "Applying BeoSuiteLite deltas (guard, patched sound/toslink, spotify source, configs)"
	install -m0644 "$REPO/deploy/opt-beocreate/beo-guard.js" /opt/beocreate/beo-guard.js
	# Patched upstream files (vendored, so no fragile line-numbered patching):
	install -m0644 "$REPO/deploy/beo-extensions/sound/index.js"   /opt/beocreate/beo-extensions/sound/index.js
	install -m0644 "$REPO/deploy/beo-extensions/toslink/index.js" /opt/beocreate/beo-extensions/toslink/index.js
	# Custom Spotify source extension (keeps the upstream Spotify icon assets):
	install -d /opt/beocreate/beo-extensions/spotify
	install -m0644 "$REPO"/deploy/beo-extensions/spotify/index.js         /opt/beocreate/beo-extensions/spotify/index.js
	install -m0644 "$REPO"/deploy/beo-extensions/spotify/menu.html        /opt/beocreate/beo-extensions/spotify/menu.html
	install -m0644 "$REPO"/deploy/beo-extensions/spotify/spotify-client.js /opt/beocreate/beo-extensions/spotify/spotify-client.js
	install -m0644 "$REPO"/deploy/beo-extensions/spotify/package.json     /opt/beocreate/beo-extensions/spotify/package.json
	# The upstream login menu is gone; drop its now-unused settings page cruft if present:
	rm -f /opt/beocreate/beo-extensions/spotify/spotifyd-*.js 2>/dev/null || true

	info "System configuration (/etc/beocreate)"
	install -d /etc/beocreate
	install -m0644 "$REPO"/deploy/etc-beocreate/system.json  /etc/beocreate/system.json
	install -m0644 "$REPO"/deploy/etc-beocreate/sound.json   /etc/beocreate/sound.json
	install -m0644 "$REPO"/deploy/etc-beocreate/toslink.json /etc/beocreate/toslink.json

	info "DSP profile into place"
	install -d /opt/beocreate/beo-dsp-programs
	install -m0644 "$REPO/dsp/$DSP_PROFILE" "/opt/beocreate/beo-dsp-programs/$DSP_PROFILE"
	install -m0644 "$REPO/dsp/$DSP_PROFILE" "/root/$DSP_PROFILE"

	install -m0644 "$REPO/deploy/systemd/beocreate2.service" /etc/systemd/system/beocreate2.service
	systemctl daemon-reload
	systemctl enable beocreate2.service
}

# --- phase 3: go-librespot (Spotify Connect) --------------------------------
phase_go_librespot() {
	log "Phase 3/5 — go-librespot (Spotify Connect)"
	install -d /opt/go-librespot
	if [ ! -x /opt/go-librespot/go-librespot ]; then
		info "Downloading go-librespot ${GLR_VERSION} (arm64)"
		curl -fsSL -o /tmp/go-librespot.tar.gz \
			"https://github.com/devgianlu/go-librespot/releases/download/${GLR_VERSION}/go-librespot_linux_arm64.tar.gz"
		tar -xzf /tmp/go-librespot.tar.gz -C /opt/go-librespot go-librespot
		chmod +x /opt/go-librespot/go-librespot
	else
		info "go-librespot binary already present"
	fi

	info "Config for user '$TARGET_USER' at $TARGET_HOME/.config/go-librespot"
	install -d -o "$TARGET_USER" -g "$TARGET_USER" "$TARGET_HOME/.config/go-librespot"
	install -o "$TARGET_USER" -g "$TARGET_USER" -m0644 \
		"$REPO/deploy/go-librespot/config.yml" "$TARGET_HOME/.config/go-librespot/config.yml"

	# Service (adapt user/home if the sudo user is not 'pi').
	sed -e "s#User=pi#User=$TARGET_USER#" \
	    -e "s#/home/pi/#$TARGET_HOME/#g" \
	    "$REPO/deploy/go-librespot/go-librespot.service" > /etc/systemd/system/go-librespot.service
	systemctl daemon-reload
	systemctl enable go-librespot.service
}

# --- phase 4: audiocontrol2 shim + DSP watchdog ----------------------------
phase_shim() {
	log "Phase 4/5 — audiocontrol2 shim (:81) + DSP watchdog"
	install -d /opt/beocreate/audiocontrol-shim
	install -m0644 "$REPO/deploy/audiocontrol-shim/shim.js" /opt/beocreate/audiocontrol-shim/shim.js
	install -m0644 "$REPO/deploy/audiocontrol-shim/audiocontrol-shim.service" \
		/etc/systemd/system/audiocontrol-shim.service

	info "DSP watchdog (runtime self-healing: heal -> reboot -> degraded, all logged)"
	install -d /opt/beocreate/dsp-watchdog
	install -m0755 "$REPO/deploy/dsp-watchdog/dsp-watchdog.sh" /opt/beocreate/dsp-watchdog/dsp-watchdog.sh
	install -m0644 "$REPO/deploy/dsp-watchdog/dsp-watchdog.service" /etc/systemd/system/dsp-watchdog.service

	systemctl daemon-reload
	systemctl enable audiocontrol-shim.service dsp-watchdog.service
}

# --- sub-command: report the DSP state (handles the empty-EEPROM deadlock) --
cmd_check_dsp() {
	need_root
	local cs; cs="$(dsp_checksum)"
	if [ "$cs" = "$DSP_CHECKSUM_EXPECTED" ]; then
		log "DSP OK — program present in EEPROM (checksum $cs). Self-boot is working."
		return 0
	elif [ -z "$cs" ]; then
		warn "Could not read the DSP checksum."
		info "Is sigmatcpserver running and was the SPI/I2S reboot done?"
		info "  sudo systemctl start sigmatcpserver   # then re-run: sudo ./install.sh check-dsp"
		return 2
	else
		warn "DSP has NO valid program (checksum: $cs)."
		cat <<'EOF'
    This is the empty-EEPROM / "SPI returns zeros" state.

    IMPORTANT — the deadlock: on a fresh board, self-boot jumper J1 fitted +
    an empty EEPROM means the DSP core never starts, so it CANNOT be programmed
    while J1 is in place. To flash the program:

        power off  ->  REMOVE jumper J1  ->  power on
        sudo ./install.sh flash-dsp
        power off  ->  RE-INSERT jumper J1  ->  power on   (DSP now self-boots)
        sudo ./install.sh safe-volume
EOF
		return 1
	fi
}

# --- sub-command: flash the DSP profile (run with J1 REMOVED) ---------------
cmd_flash_dsp() {
	need_root
	command -v dsptoolkit >/dev/null || die "dsptoolkit not found — run the base install first."

	# If it's already programmed and self-booting, nothing to do.
	if [ "$(dsp_checksum)" = "$DSP_CHECKSUM_EXPECTED" ]; then
		log "DSP already holds the correct program (checksum matches). Nothing to flash."
		return 0
	fi

	warn "Flashing the DSP EEPROM. The self-boot jumper J1 MUST be REMOVED right now,"
	warn "otherwise a fresh board deadlocks (empty EEPROM + J1 = DSP core never starts)."
	info "Profile: /root/$DSP_PROFILE"
	dsptoolkit install-profile "/root/$DSP_PROFILE" || true
	sleep 2

	local cs; cs="$(dsp_checksum)"
	if [ "$cs" = "$DSP_CHECKSUM_EXPECTED" ]; then
		log "DSP flashed and VERIFIED (checksum $cs)."
		info "Now: power off, RE-INSERT J1, power on, then run: sudo ./install.sh safe-volume"
	else
		die "Flash did not verify (checksum: '${cs:-unreadable}').
    The most likely cause: jumper J1 is still fitted. A fresh board with J1 set +
    empty EEPROM is DEADLOCKED and cannot be programmed. REMOVE J1 and run again:
        sudo ./install.sh flash-dsp"
	fi
}

# --- sub-command: set a safe low volume and persist it ----------------------
cmd_safe_volume() {
	need_root
	local pct="${1:-$SAFE_VOLUME_PCT}"
	amixer sget DSPVolume >/dev/null 2>&1 || die "DSPVolume mixer not found — is sigmatcpserver running and the DSP flashed?"
	amixer set DSPVolume "${pct}%" >/dev/null
	alsactl store
	log "DSPVolume set to ${pct}% and stored (safe boot volume). Current:"
	amixer get DSPVolume | grep -oE '\[[0-9]+%\]' | head -1
}

# --- base install (all phases) ---------------------------------------------
cmd_install() {
	preflight
	phase_base
	phase_dsp_backend
	phase_beocreate
	phase_go_librespot
	phase_shim
	cat <<EOF

$(printf '\033[1;32m')Base software install complete.$(printf '\033[0m')

Services enabled: sigmatcpserver, beocreate2, audiocontrol-shim, go-librespot,
dsp-watchdog (runtime self-healing for the DSP: restarts services, and as a
last resort reboots the Pi — rate-limited; watch it with 'journalctl -u dsp-watchdog').

MANUAL NEXT STEPS (hardware — cannot be automated):

  1) REBOOT so the SPI/I2S overlay and spidev.bufsiz take effect:
         sudo reboot

  2) Check the DSP state (does the EEPROM already hold a program?):
         sudo ./install.sh check-dsp

  3) If it reports NO valid program (fresh board / "SPI returns zeros"):
     the board is deadlocked while jumper J1 is fitted, so flash it with J1 OUT:
         - Power off, REMOVE the self-boot jumper J1, power on.
         - Run:   sudo ./install.sh flash-dsp     # flashes AND verifies
         - Power off, RE-INSERT J1, power on (DSP now self-boots).

  4) Set a safe starting volume (with the DSP running):
         sudo ./install.sh safe-volume

  Then open the web UI at  http://<pi-ip>/  and select "Beocreate" in the
  Spotify app. KEEP THE VOLUME LOW on first sound.

To adapt to a different HiFiBerry DSP board: replace dsp/*.xml and adjust
cardType/cardFeatures in deploy/etc-beocreate/system.json and the ALSA device
name in deploy/go-librespot/config.yml.
EOF
}

# --- dispatch ---------------------------------------------------------------
case "${1:-install}" in
	install)      cmd_install ;;
	check-dsp)    cmd_check_dsp ;;
	flash-dsp)    cmd_flash_dsp ;;
	safe-volume)  shift || true; cmd_safe_volume "${1:-}" ;;
	*)            die "Unknown command '$1' (use: install | check-dsp | flash-dsp | safe-volume)";;
esac
