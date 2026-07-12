# Beocreate 4‑Channel Amplifier — Standalone Setup on Raspberry Pi OS Lite

A clean rebuild to make the **HiFiBerry Beocreate 4‑Channel Amplifier** (Analog Devices ADAU1451 SigmaDSP) fully usable on a Raspberry Pi 3B — with the original **Beocreate 2 web interface** (EQ, channels, volume, Optical/TOSLINK), without the discontinued HiFiBerryOS and without the fragile 2019 `audiocontrol2` daemon.

**Primary source:** optical input (TOSLINK) from the PC. **Secondary:** Spotify Connect (via go‑librespot, fully integrated).

## Hardware

- Raspberry Pi 3B, Raspberry Pi OS **Lite 64‑bit (Trixie)**, kernel 6.18.
- HiFiBerry Beocreate 4‑Channel Amplifier (ADAU1451 DSP + 4‑channel DAC/amp + TOSLINK in/out), SPI control.
- **Jumper:** J1 **self‑boot = set** (DSP boots its program from EEPROM). J5 **Output Voltage Limiter = set** (protection). ⚠️ To *program* the DSP, J1 must be **removed** (see below).
- Speakers on the **60 W channels CH16 (left) / CH17 (right)** → in the DSP profile `channelSelect` 0/1 = L/R, correct.

## Installation

An installer (`install.sh`) automates the **software** setup. It cannot do the
two **hardware** steps (flashing the DSP EEPROM needs the physical J1 jumper, and
wiring the speakers/optical cable) — those are guided at the end of the run.

> ⚠️ **Volume safety:** this drives a real amplifier at full power. The installer
> deliberately stores a **low** starting `DSPVolume`. Keep the volume low on first
> sound and raise it gradually.

**Prerequisites:** a fresh **Raspberry Pi OS Lite 64‑bit**, SSH/network up, and the
Beocreate board fitted (J5 voltage limiter set).

```bash
git clone https://github.com/PSi86/BeoSuiteLite
cd BeoSuiteLite
sudo ./install.sh            # base software: apt, boot config, hifiberry-dsp,
                             # Beocreate 2 (+ our patches/extensions), go-librespot, shim
```

Then the guided hardware steps:

```bash
sudo reboot                  # 1) apply the SPI/I2S overlay + spidev.bufsiz

# 2) flash the DSP program (power off → REMOVE jumper J1 → power on):
sudo ./install.sh flash-dsp
#    then: power off → RE‑INSERT J1 → power on (DSP now self‑boots)

# 3) set + persist a safe starting volume (DSP running):
sudo ./install.sh safe-volume
```

Open `http://<pi-ip>/` for the web UI, and select **“Beocreate”** in the Spotify
app (Premium required for playback).

**What the installer does (idempotent, re‑runnable):** enables the HiFiBerry DAC +
SPI/I2S/I2C in `config.txt`, sets `spidev.bufsiz` in `cmdline.txt`, adds the
HiFiBerry apt repo and installs `hifiberry-dsp` (with the `sigmatcpserver`
override for `:8086` + `DSPVolume`), clones **Beocreate 2** from
`bang-olufsen/create` and applies the deltas from `deploy/` (guard preload,
patched `sound`/`toslink`, the custom `spotify` source, `/etc/beocreate` configs,
Express‑4 pin), installs **go‑librespot** `v0.7.4` + config + service, and the
**audiocontrol2 shim**; all services are `enable`d.

**Other DSP boards:** replace `dsp/*.xml`, adjust `cardType`/`cardFeatures` in
`deploy/etc-beocreate/system.json`, and the ALSA device name in
`deploy/go-librespot/config.yml` — the architecture and glue carry over
(see [Key findings & fixes](#key-findings--fixes)).

## Architecture

```
/boot/firmware/config.txt: dtoverlay=hifiberry-dac, dtparam=spi=on,i2s=on,i2c_arm=on, audio=off
        │
hifiberry-dsp · sigmatcpserver (AS ROOT): --alsa --enable-rest
        ├─ SigmaTCP 0.0.0.0:8086   ← Beocreate 2 (beocreate_essentials/dsp.js)
        ├─ ALSA-Control "DSPVolume" ↔ DSP-Register 106   (--alsa AlsaSync)
        └─ REST 127.0.0.1:13141    (diagnostics / register access)
        │  (SPI) → ADAU1451-DSP ← program from EEPROM (self-boot, J1 set)
        │
audiocontrol-shim (Node) :81  ← audiocontrol2 replacement + Spotify integration
        ├─ GET  /api/player/status · /api/track/metadata · /api/volume
        ├─ POST /api/player/<cmd>  → maps to go-librespot :3678/player/<cmd>
        ├─ polls go-librespot :3678/status  → state+metadata
        └─ pushes Beocreate :80/sources/metadata (Now-Playing)
        │
go-librespot (Go) :3678       ← Spotify Connect ("Beocreate")
        └─ ALSA plughw:sndrpihifiberry → I2S → DSP → DAC (gets EQ)
        │
Beocreate 2 UI (Node 20) :80  ← EQ / 4-channel / Optical / Spotify / volume / sources
```

The DSP program (`beocreate-universal-11.xml`) resides **in the board's EEPROM** and is loaded by the DSP itself on every power‑up (self‑boot). The Pi does **not** need to run any software for this. `hifiberry-dsp` + Beocreate 2 are only responsible for control/UI.

## Key findings & fixes

1. **DSP programming deadlock (the "difficult DSP connection"):** With J1 (self‑boot) set **and an empty EEPROM**, the DSP cannot be programmed — program/data RAM is dead (all reads 0, "SPI returned only zeros"), only the control registers (0xF000+) are reachable. The old v9/moOde setup had erased the EEPROM → deadlock. **Solution (documented by HiFiBerry):** shut down the Pi, remove power, **pull J1**, boot, `dsptoolkit install-profile ~/beocreate-universal-11.xml` → loads the program into RAM (0xC000/DM0) **and** writes the EEPROM. Then **set J1 again + power‑cycle** → DSP self‑boots permanently. Success = checksum signature `97C9C5…`, program length 1142 words.
2. **`sigmatcpserver` flags:** The package default `--localhost --disable-tcp` turns off the 8086 server (which Beocreate 2 needs). Override → `--alsa --enable-rest` (binds `0.0.0.0:8086`, creates `DSPVolume`).
3. **`--alsa` bug (1.3.11):** `create_mixer` internally calls `Mixer(name)` without a card specification → fails if the control does not yet exist → the service aborts. **Once `DSPVolume` exists** (`amixer` + `alsactl store`), `--alsa` finds it and runs. The initial value is deliberately stored low (30 % ≈ −42 dB).
4. **Beocreate 2 crashes with Express 5** (`path-to-regexp 8`, `beo-server.js:366`) → **pin Express to `^4.18`** (installs 4.22.2 / path‑to‑regexp 0.1.13).
5. **`beocreate_essentials`** sits at the top level of the repo (not in `Beocreate2/`) → must be moved to `/opt/beocreate/beocreate_essentials`.
6. **audiocontrol2 coupling:** `sound`/`sources` call `http://127.0.1.1:81/api/…` (audiocontrol2). If the service is missing, unhandled fetch rejections crash the server → **guard preload** (`beo-guard.js`, `node --require`) catches them. In addition, an extension **allowlist** (`enabledExtensions`) is used to exclude HiFiBerryOS/streaming extensions (network, mpd, spotify, …).
7. **Volume control dead:** `getVolumeViaAudioControl` has **no `.catch()`** → when audiocontrol2 is missing, the callback is never called → `determineVolumeControl` never runs → `volumeControl=0`. **Fix:** small patch (`.catch → callback(null)`, see `deploy/patches/`) + `sound.json` `"mixer":"DSPVolume"`. Afterwards the control works (drives reg 106).
8. **TOSLINK source:** Default `toslinkEnabled:false` → never active. `toslink.json` `"toslinkEnabled":true` → auto‑activation on signal (reg 93), sets reg 4841=1.
9. **⭐ `cardFeatures` must contain `"toslink"` (the actual cause of the missing sources list):** Beocreate only loads an extension if ALL of its `requireCardFeatures` (from its `package.json`) are listed in `system.json` → `cardFeatures`. The `toslink` extension requires `["toslink"]`. With `cardFeatures:["dsp"]` its server code was **silently skipped** (no error in the log, only the harmless line "…listed to be loaded"), i.e. the Optical source was never registered and the auto‑unmute polling never started. Fix: `cardFeatures:["dsp","toslink"]`. Afterwards: "Registering source 'toslink'…" → "All sources registered." → "Polling Toslink status every 2 seconds…" → Optical appears in the sources list. (Feature vocabulary of the extensions: `dsp`, `toslink`, `analoginput`, `bluetooth`, `arm7`, `localui`.)
10. **audiocontrol2 shim (`:81`):** A dedicated, dependency‑free Node service that provides the REST subset expected by `sources`/`sound` (empty player list + live volume from `DSPVolume`). It cleanly eliminates the `ECONNREFUSED`/`unhandledRejection` flood (instead of merely catching it via guard/`.catch`) and is the seam/hook at which **go‑librespot** later feeds Spotify in as a real source (`POST /internal/player`).
11. **toslink robustness:** `dsp-programs.getSigmaTCPSettings()` returns `undefined` when `/etc/sigmatcp.conf` is missing; the toslink startup then read `.server` on it → uncaughtException. A one‑line null check (`deploy/patches/toslink-sigmatcp-nullcheck.patch`) makes the startup listener run deterministic.
12. **Spotify integration (go‑librespot):** `go-librespot` (arm64, `zeroconf_backend: avahi` → avoids a 5353 conflict) runs as a service and plays via `plughw:sndrpihifiberry` → I2S → DSP → amp (so it gets the EQ). The **shim polls** `go-librespot` (`GET :3678/status`) and **pushes** state+metadata in audiocontrol2 format to Beocreate (`POST :80/sources/metadata` → `processAudioControlMetadata`; this push path exists in beo‑server via the route `/:extension/:header`). **Transport** from the UI runs in the reverse direction: `POST :81/api/player/<cmd>` → shim → `go-librespot :3678/player/<cmd>` (play→resume …). The **source tile + the icon** come from `beo-extensions/spotify/menu.html` (`<div class="menu-screen source" data-icon="spotify.svg">`) — a minimal, decoupled extension (instead of the HiFiBerryOS variant with `arm7`/login). An **on/off switch** starts/stops the `go-librespot` service (`systemctl enable/disable --now`).
13. **Automatic source priority (without an extra script):** Because the Spotify source is `usesHifiberryControl:true`, Beocreate's **native `stopOthers` logic** automatically pauses Spotify as soon as TOSLINK becomes active (`audioControl("pause")` → shim → go‑librespot). Conversely, the edge‑based toslink detection received a **re‑assert** (`deploy/patches/toslink-source-reassert.patch`): if the optical signal is still present and **no** source is active (Spotify paused), Optical is re‑activated — otherwise Now‑Playing would stay empty, since without a signal edge nothing triggers. **Polling note:** two cyclic reads deliberately remain — toslink reads DSP reg 93 every 2 s (the DSP offers no push; unavoidable), the shim polls go‑librespot every 1 s (local, negligible; deliberately no WebSocket).

## Deployment artifacts (`deploy/`)

| File | Target on the Pi | Purpose |
|---|---|---|
| `systemd/beocreate2.service` | `/etc/systemd/system/` | Beocreate 2 UI (Node, as root); `After/Wants audiocontrol-shim`; without debug flag (production). |
| `systemd/sigmatcpserver.service.d/override.conf` | `/etc/systemd/system/sigmatcpserver.service.d/` | Flags override (8086 + DSPVolume) |
| `audiocontrol-shim/shim.js` | `/opt/beocreate/audiocontrol-shim/` | audiocontrol2 replacement on `:81` + go‑librespot integration (poll/push/transport) |
| `audiocontrol-shim/audiocontrol-shim.service` | `/etc/systemd/system/` | systemd unit for the shim (as root, `enable`d) |
| `go-librespot/config.yml` | `~pi/.config/go-librespot/` | Spotify Connect config (avahi, plughw, API :3678, safe volume) |
| `go-librespot/go-librespot.service` | `/etc/systemd/system/` | Service (user `pi`, `enable`d); binary `v0.7.4` arm64 to `/opt/go-librespot/` |
| `beo-extensions/spotify/` | `/opt/beocreate/beo-extensions/spotify/` | minimal Spotify source extension (tile/icon/on‑off switch); replaces the original (backup: `~pi/beo-extension-spotify-orig`) |
| `beo-extensions/toslink/index.js` | `/opt/beocreate/beo-extensions/toslink/` | **vendored** (upstream + null check + source re‑assert) |
| `etc-beocreate/system.json` | `/etc/beocreate/` | cardType/**cardFeatures `["dsp","toslink"]`**/port/extension allowlist (incl. `spotify`) |
| `etc-beocreate/sound.json` | `/etc/beocreate/` | `mixer: DSPVolume` (volume fix) |
| `etc-beocreate/toslink.json` | `/etc/beocreate/` | `toslinkEnabled: true` |
| `etc-modprobe.d/spidev.conf` | `/etc/modprobe.d/` | `bufsiz=131072` (does NOT take effect at boot — see cmdline) |
| `cmdline.txt.additions` | `/boot/firmware/cmdline.txt` | **`spidev.bufsiz=131072`** (effective at boot; needed for re‑flashing the DSP) |
| `opt-beocreate/beo-guard.js` | `/opt/beocreate/` | global error guard (preload) |
| `patches/sound-audiocontrol-catch.patch` | `beo-extensions/sound/index.js` | `.catch` on the audiocontrol fetch |
| `patches/toslink-sigmatcp-nullcheck.patch` · `patches/toslink-source-reassert.patch` | docs | two toslink changes (included in the vendored `index.js`) |
| `config.txt.additions` | `/boot/firmware/config.txt` | hifiberry‑dac + SPI/I2S/I2C + audio=off |
| `../dsp/beocreate-universal-11.xml` | `~/` → EEPROM | DSP program (checksum `97C9C5…`) |

Beocreate 2 itself is deployed from `github.com/bang-olufsen/create` to `/opt/beocreate` (contents of `Beocreate2/` + `beocreate_essentials/`); npm deps in `/opt/beocreate/node_modules` with `express@^4.18`.

## Current status

**Working (verified after reboot):** DSP self‑boots · TOSLINK/PC audible, stereo correct · Beocreate 2 UI on `:80` (EQ, channels, Optical, Beosonic, presets) · **master volume control** · **audiocontrol2 shim on `:81`** · **sources list shows "Optical Input" + "Spotify Connect"** (each with icon, correct active indication/switching) · **Spotify Connect** fully: device "Beocreate" in the app, Now‑Playing (title/artist/album/cover), transport (play/pause/skip), on/off switch, automatic TOSLINK priority · **reboot‑proof** (all services `enable`d, safe boot volume, `spidev.bufsiz=131072` takes effect).

**Open:**
- **Power‑cycle test** (power off/on) as final assurance — reboot is already OK.
- Nice‑to‑have: seek (jumping within a track) for Spotify is not wired up yet.

## ⚠️ Volume safety

DSP register **106** = linear factor (8.24 fixed point): `1.0 = 0 dB = full scale`. **Never write > 1.0.** Leave limit register **74** at 1.0. Jumper J5 (voltage limiter) provides additional protection. Always start the first sound quietly, then raise it gradually.

## Access

Pi (Raspberry Pi OS Lite): reachable on the local network by its hostname or DHCP address; default user `pi`. Web UI: `http://<pi-ip>/`.

## Repo structure

- `install.sh` — idempotent installer (`install` · `flash-dsp` · `safe-volume`)
- `deploy/` — deployment artifacts (see table); incl. `hifiberry/` (apt keyring) and the vendored, patched `beo-extensions/sound/index.js`
- `dsp/` — DSP program (EEPROM image as XML)
- `_old_/` — reference material (old ChatGPT chat, moOde v9 port); **gitignored**
