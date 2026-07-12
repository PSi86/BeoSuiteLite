#!/usr/bin/env bash
#
# BeoSuiteLite DSP watchdog — runtime self-healing for the DSP subsystem
# ======================================================================
# Periodically verifies that the DSP control stack is healthy:
#   * sigmatcpserver is active,
#   * the DSP answers over the REST API and holds a valid program (checksum),
#   * the ALSA "DSPVolume" control exists.
#
# On failure it escalates and LOGS every step (journald):
#   1) restart sigmatcpserver               (fixes a hung/dead control server,
#                                            a missing DSPVolume, an SPI re-init)
#   2) + restart beocreate2                 (re-establish the DSP connection)
#   3) reboot the Pi                        (last resort: re-trigger DSP self-boot),
#      rate-limited to avoid a reboot loop
#   4) DEGRADED mode                        (cannot self-heal — e.g. empty EEPROM
#                                            needs the J1 jumper + a re-flash):
#                                            keep monitoring slowly, log loudly,
#                                            recover automatically once fixed.
#
# It must NEVER exit on its own (systemd Restart=on-failure is only a backstop).
# Config can be overridden in /etc/default/dsp-watchdog.

set -o pipefail   # deliberately NOT set -e / -u: the loop must survive any error.

# --- configuration ----------------------------------------------------------
CHECK_INTERVAL="${CHECK_INTERVAL:-30}"                     # seconds between checks
STARTUP_GRACE="${STARTUP_GRACE:-60}"                       # settle time after boot
GRACE_AFTER_ACTION="${GRACE_AFTER_ACTION:-20}"             # settle time after a restart
MAX_HEALS_BEFORE_REBOOT="${MAX_HEALS_BEFORE_REBOOT:-3}"    # failed heals before a reboot
REBOOT_ENABLED="${REBOOT_ENABLED:-1}"                      # 0 = never reboot (log instead)
MIN_SECONDS_BETWEEN_REBOOTS="${MIN_SECONDS_BETWEEN_REBOOTS:-1800}"  # reboot-loop guard (30 min)
DEGRADED_BACKOFF="${DEGRADED_BACKOFF:-300}"                # slow-poll while unrecoverable
DSP_REST="${DSP_REST:-http://127.0.0.1:13141}"
DSP_CHECKSUM_EXPECTED="${DSP_CHECKSUM_EXPECTED:-97C9C5A88582888D111259BF70D6D79E}"  # empty = accept any valid program
ALSA_MIXER="${ALSA_MIXER:-DSPVolume}"
BEOCREATE_URL="${BEOCREATE_URL:-http://127.0.0.1:80/}"     # UI liveness probe
SIGMATCP_SERVICE="${SIGMATCP_SERVICE:-sigmatcpserver.service}"
BEOCREATE_SERVICE="${BEOCREATE_SERVICE:-beocreate2.service}"
STATE_DIR="/var/lib/dsp-watchdog"

log() { printf '[dsp-watchdog] %s\n' "$*"; }

dsp_checksum() {
	curl -s -m5 "$DSP_REST/checksum" 2>/dev/null \
		| grep -oE '"checksum":"[0-9A-Fa-f]+"' | head -1 | sed 's/.*:"//; s/"//'
}

REASON=""
healthy() {
	REASON=""
	if ! systemctl is-active --quiet "$SIGMATCP_SERVICE"; then REASON="$SIGMATCP_SERVICE not active"; return 1; fi
	local cs; cs="$(dsp_checksum)"
	if [ -z "$cs" ]; then REASON="DSP not responding (no checksum via REST)"; return 1; fi
	if [ -n "$DSP_CHECKSUM_EXPECTED" ] && [ "$cs" != "$DSP_CHECKSUM_EXPECTED" ]; then
		REASON="DSP checksum mismatch (got $cs)"; return 1
	fi
	if ! amixer sget "$ALSA_MIXER" >/dev/null 2>&1; then REASON="ALSA control '$ALSA_MIXER' missing"; return 1; fi
	# Beocreate 2 UI must be serving (also catches it being torn down when
	# sigmatcpserver restarts, since beocreate2 Requires= it).
	local code; code="$(curl -s -o /dev/null -m5 -w '%{http_code}' "$BEOCREATE_URL" 2>/dev/null || echo 000)"
	if [ "$code" != "200" ]; then REASON="Beocreate 2 UI not serving (HTTP $code)"; return 1; fi
	return 0
}

# Returns 0 only if it actually initiated a reboot (process then goes down);
# returns 1 if it declined (disabled or loop-guard).
maybe_reboot() {
	if [ "$REBOOT_ENABLED" != "1" ]; then
		log "ESCALATION: restarts did not recover the DSP and reboot is disabled — MANUAL ATTENTION NEEDED."
		return 1
	fi
	mkdir -p "$STATE_DIR" 2>/dev/null || true
	local now last since
	now="$(date +%s)"
	last="$(cat "$STATE_DIR/last-reboot" 2>/dev/null || echo 0)"
	since=$(( now - last ))
	if [ "$since" -lt "$MIN_SECONDS_BETWEEN_REBOOTS" ]; then
		log "ESCALATION: DSP still unhealthy, but a watchdog reboot happened ${since}s ago (< ${MIN_SECONDS_BETWEEN_REBOOTS}s). NOT rebooting again (loop guard). The DSP likely needs manual attention (empty EEPROM / jumper J1 / wiring) — diagnose with: sudo ./install.sh check-dsp"
		return 1
	fi
	log "ESCALATION: last resort — rebooting the Pi to re-initialise the DSP (self-boot)."
	echo "$now" > "$STATE_DIR/last-reboot" 2>/dev/null || true
	sync
	systemctl reboot
	return 0
}

# --- main loop --------------------------------------------------------------
mkdir -p "$STATE_DIR" 2>/dev/null || true
log "started (interval=${CHECK_INTERVAL}s, heals-before-reboot=${MAX_HEALS_BEFORE_REBOOT}, reboot_enabled=${REBOOT_ENABLED})"
sleep "$STARTUP_GRACE"

fails=0
degraded=0
while true; do
	if healthy; then
		if [ "$degraded" = 1 ] || [ "$fails" -gt 0 ]; then log "RECOVERED: DSP is healthy again."; fi
		fails=0; degraded=0
		sleep "$CHECK_INTERVAL"; continue
	fi

	# In degraded mode we only monitor + log (auto-restarts don't help here).
	if [ "$degraded" = 1 ]; then
		log "STILL UNHEALTHY (degraded): $REASON — manual attention needed (sudo ./install.sh check-dsp). Monitoring."
		sleep "$DEGRADED_BACKOFF"; continue
	fi

	fails=$(( fails + 1 ))
	log "UNHEALTHY (#$fails): $REASON"

	if [ "$fails" -le "$MAX_HEALS_BEFORE_REBOOT" ]; then
		# Restart sigmatcpserver AND beocreate2: restarting sigmatcpserver tears
		# beocreate2 down (Requires=), so it must be brought back up to re-establish
		# the DSP connection.
		log "HEAL $fails/$MAX_HEALS_BEFORE_REBOOT: restarting $SIGMATCP_SERVICE + $BEOCREATE_SERVICE"
		systemctl restart "$SIGMATCP_SERVICE" || log "  (restart of $SIGMATCP_SERVICE returned an error)"
		systemctl restart "$BEOCREATE_SERVICE" || log "  (restart of $BEOCREATE_SERVICE returned an error)"
		sleep "$GRACE_AFTER_ACTION"
	else
		if ! maybe_reboot; then
			log "DEGRADED: the DSP could not be recovered automatically. Backing off to ${DEGRADED_BACKOFF}s monitoring; will report RECOVERED once the DSP is healthy."
			degraded=1; fails=0
			sleep "$DEGRADED_BACKOFF"; continue
		fi
	fi
	sleep "$CHECK_INTERVAL"
done
