# Beocreate 4‑Channel Amplifier — Standalone‑Setup auf Raspberry Pi OS Lite

Sauberer Neuaufbau, um den **HiFiBerry Beocreate 4‑Channel Amplifier** (Analog Devices ADAU1451 SigmaDSP) an einem Raspberry Pi 3B voll nutzbar zu machen — mit der originalen **Beocreate‑2‑Weboberfläche** (EQ, Kanäle, Lautstärke, Optical/TOSLINK), ohne das eingestellte HiFiBerryOS und ohne den fragilen 2019er‑`audiocontrol2`‑Daemon.

**Primärquelle:** optischer Eingang (TOSLINK) vom PC. **Sekundär:** Spotify Connect (folgt).

## Hardware

- Raspberry Pi 3B, Raspberry Pi OS **Lite 64‑bit (Trixie)**, Kernel 6.18.
- HiFiBerry Beocreate 4‑Channel Amplifier (ADAU1451 DSP + 4‑Kanal‑DAC/Amp + TOSLINK in/out), SPI‑Steuerung.
- **Jumper:** J1 **Selfboot = gesetzt** (DSP bootet Programm aus EEPROM). J5 **Output Voltage Limiter = gesetzt** (Schutz). ⚠️ Zum *Programmieren* des DSP muss J1 **gezogen** werden (siehe unten).
- Lautsprecher an den **60‑W‑Kanälen CH16 (links) / CH17 (rechts)** → im DSP‑Profil `channelSelect` 0/1 = L/R, stimmt.

## Architektur

```
/boot/firmware/config.txt: dtoverlay=hifiberry-dac, dtparam=spi=on,i2s=on,i2c_arm=on, audio=off
        │
hifiberry-dsp · sigmatcpserver (ALS ROOT): --alsa --enable-rest
        ├─ SigmaTCP 0.0.0.0:8086   ← Beocreate 2 (beocreate_essentials/dsp.js)
        ├─ ALSA-Control "DSPVolume" ↔ DSP-Register 106   (--alsa AlsaSync)
        └─ REST 127.0.0.1:13141    (Diagnose / Register-Zugriff)
        │  (SPI) → ADAU1451-DSP ← Programm aus EEPROM (Self-Boot, J1 gesetzt)
        │
audiocontrol-shim (Node) :81  ← eigener, schlanker audiocontrol2-Ersatz
        ├─ GET  /api/player/status · /api/track/metadata · /api/volume
        ├─ POST /api/player/<cmd> · /activate/<name> · /api/track/love
        └─ POST /internal/player   (Naht für spätere go-librespot-Bridge)
        │
Beocreate 2 UI (Node 20) :80  ← EQ / 4-Kanal / Optical / Lautstärke / Quellen
```

Das DSP‑Programm (`beocreate-universal-11.xml`) liegt **im EEPROM des Boards** und wird bei jedem Einschalten vom DSP selbst geladen (Self‑Boot). Der Pi muss dafür **keine** Software laufen lassen. `hifiberry-dsp` + Beocreate 2 sind nur für Steuerung/UI zuständig.

## Wichtigste Erkenntnisse & Fixes

1. **DSP‑Programmier‑Deadlock (die „schwierige DSP‑Verbindung"):** Mit J1 (Selfboot) gesetzt **und leerem EEPROM** lässt sich der DSP nicht programmieren — Programm‑/Daten‑RAM ist tot (alle Reads 0, „SPI returned only zeros"), nur die Steuerregister (0xF000+) sind erreichbar. Das alte v9/moOde‑Setup hatte das EEPROM gelöscht → Deadlock. **Lösung (dokumentiert bei HiFiBerry):** Pi herunterfahren, Strom weg, **J1 ziehen**, booten, `dsptoolkit install-profile ~/beocreate-universal-11.xml` → lädt Programm ins RAM (0xC000/DM0) **und** schreibt EEPROM. Dann **J1 wieder setzen + Power‑Cycle** → DSP self‑bootet dauerhaft. Erfolg = checksum‑signature `97C9C5…`, program‑length 1142 words.
2. **`sigmatcpserver` Flags:** Paket‑Default `--localhost --disable-tcp` schaltet den 8086‑Server ab (den Beocreate 2 braucht). Override → `--alsa --enable-rest` (bindet `0.0.0.0:8086`, erzeugt `DSPVolume`).
3. **`--alsa`‑Bug (1.3.11):** `create_mixer` ruft intern `Mixer(name)` ohne Karten‑Angabe → schlägt fehl, wenn die Kontrolle noch nicht existiert → Dienst bricht ab. **Sobald `DSPVolume` einmal existiert** (`amixer` + `alsactl store`), findet `--alsa` sie und läuft. Startwert bewusst niedrig (30 % ≈ −42 dB) gespeichert.
4. **Beocreate 2 crasht mit Express 5** (`path-to-regexp 8`, `beo-server.js:366`) → **Express auf `^4.18` pinnen** (installiert 4.22.2 / path‑to‑regexp 0.1.13).
5. **`beocreate_essentials`** liegt im Repo auf oberster Ebene (nicht in `Beocreate2/`) → muss nach `/opt/beocreate/beocreate_essentials`.
6. **audiocontrol2‑Kopplung:** `sound`/`sources` rufen `http://127.0.1.1:81/api/…` (audiocontrol2). Fehlt der Dienst, crashen unbehandelte Fetch‑Rejections den Server → **Guard‑Preload** (`beo-guard.js`, `node --require`) fängt sie ab. Zusätzlich Extension‑**Allowlist** (`enabledExtensions`), um HiFiBerryOS‑/Streaming‑Extensions (network, mpd, spotify, …) auszuschließen.
7. **Lautstärke‑Regler tot:** `getVolumeViaAudioControl` hat **kein `.catch()`** → bei fehlendem audiocontrol2 wird der Callback nie aufgerufen → `determineVolumeControl` läuft nie → `volumeControl=0`. **Fix:** kleiner Patch (`.catch → callback(null)`, siehe `deploy/patches/`) + `sound.json` `"mixer":"DSPVolume"`. Danach Regler funktioniert (steuert Reg 106).
8. **TOSLINK‑Quelle:** Default `toslinkEnabled:false` → nie aktiv. `toslink.json` `"toslinkEnabled":true` → Auto‑Aktivierung bei Signal (Reg 93), setzt Reg 4841=1.
9. **⭐ `cardFeatures` muss `"toslink"` enthalten (die eigentliche Ursache für die fehlende Quellen‑Liste):** Beocreate lädt eine Extension nur, wenn ALLE ihre `requireCardFeatures` (aus deren `package.json`) in `system.json` → `cardFeatures` stehen. Die `toslink`‑Extension verlangt `["toslink"]`. Mit `cardFeatures:["dsp"]` wurde ihr Server‑Code **still übersprungen** (kein Fehler im Log, nur die harmlose Zeile „…listed to be loaded"), d. h. die Optical‑Quelle wurde nie registriert und das Auto‑Unmute‑Polling nie gestartet. Fix: `cardFeatures:["dsp","toslink"]`. Danach: „Registering source 'toslink'…" → „All sources registered." → „Polling Toslink status every 2 seconds…" → Optical erscheint in der Quellen‑Liste. (Feature‑Vokabular der Extensions: `dsp`, `toslink`, `analoginput`, `bluetooth`, `arm7`, `localui`.)
10. **audiocontrol2‑Shim (`:81`):** eigener, abhängigkeitsfreier Node‑Dienst, der die von `sources`/`sound` erwartete REST‑Teilmenge liefert (leere Player‑Liste + Live‑Lautstärke aus `DSPVolume`). Beseitigt die `ECONNREFUSED`‑/`unhandledRejection`‑Flut sauber (statt sie nur per Guard/`.catch` abzufangen) und ist die Naht, an der später **go‑librespot** Spotify als echte Quelle einspeist (`POST /internal/player`).
11. **toslink‑Robustheit:** `dsp-programs.getSigmaTCPSettings()` liefert `undefined`, wenn `/etc/sigmatcp.conf` fehlt; der toslink‑Startup las darauf `.server` → uncaughtException. Ein‑Zeilen‑Null‑Check (`deploy/patches/toslink-sigmatcp-nullcheck.patch`) macht den Startup‑Listener‑Lauf deterministisch.

## Deployment‑Artefakte (`deploy/`)

| Datei | Ziel auf dem Pi | Zweck |
|---|---|---|
| `systemd/beocreate2.service` | `/etc/systemd/system/` | Beocreate‑2‑UI (Node, als root); `After/Wants audiocontrol-shim`. **Hinweis:** enthält aktuell `v` (Debug‑Stufe 1) — für Produktion entfernen. |
| `systemd/sigmatcpserver.service.d/override.conf` | `/etc/systemd/system/sigmatcpserver.service.d/` | Flags‑Override (8086 + DSPVolume) |
| `audiocontrol-shim/shim.js` | `/opt/beocreate/audiocontrol-shim/` | eigener audiocontrol2‑Ersatz auf `:81` |
| `audiocontrol-shim/audiocontrol-shim.service` | `/etc/systemd/system/` | systemd‑Unit für den Shim (als root, `enable`d) |
| `etc-beocreate/system.json` | `/etc/beocreate/` | cardType/**cardFeatures `["dsp","toslink"]`**/Port/Extension‑Allowlist |
| `etc-beocreate/sound.json` | `/etc/beocreate/` | `mixer: DSPVolume` (Lautstärke‑Fix) |
| `etc-beocreate/toslink.json` | `/etc/beocreate/` | `toslinkEnabled: true` |
| `etc-modprobe.d/spidev.conf` | `/etc/modprobe.d/` | `bufsiz=131072` (große SPI‑Reads; **greift noch nicht bei Boot → offen: via cmdline.txt**) |
| `opt-beocreate/beo-guard.js` | `/opt/beocreate/` | globaler Fehler‑Guard (Preload) |
| `patches/sound-audiocontrol-catch.patch` | `beo-extensions/sound/index.js` | `.catch` am audiocontrol‑Fetch |
| `patches/toslink-sigmatcp-nullcheck.patch` | `beo-extensions/toslink/index.js` | Null‑Check gegen fehlende `/etc/sigmatcp.conf` |
| `config.txt.additions` | `/boot/firmware/config.txt` | hifiberry‑dac + SPI/I2S/I2C + audio=off |
| `../dsp/beocreate-universal-11.xml` | `~/` → EEPROM | DSP‑Programm (checksum `97C9C5…`) |

Beocreate 2 selbst wird aus `github.com/bang-olufsen/create` nach `/opt/beocreate` deployt (Inhalt von `Beocreate2/` + `beocreate_essentials/`); npm‑Deps in `/opt/beocreate/node_modules` mit `express@^4.18`.

## Aktueller Stand

**Funktioniert:** DSP self‑bootet (übersteht Power‑Cycle) · TOSLINK/PC hörbar, Stereo korrekt · Beocreate‑2‑UI auf `:80` (EQ, Kanäle, Optical, Beosonic, Presets) · **Master‑Lautstärke‑Regler in der UI** · **audiocontrol2‑Shim auf `:81`** (saubere Logs, keine `ECONNREFUSED`‑Flut mehr) · **Quellen‑Liste zeigt „Optical Input"** (auto‑aktiviert bei PC‑Signal, mit Auto‑Unmute‑Polling).

**Offen / nächste Schritte:**
- **Spotify Connect** (`go-librespot`) als echte Quelle über die Shim‑Naht `POST /internal/player` + automatische TOSLINK‑Priorität.
- `bufsiz` persistent via `cmdline.txt`; Debug (`v`) aus `beocreate2.service` entfernen; Reboot/Power‑Cycle‑Härtung.

## ⚠️ Lautstärke‑Sicherheit

DSP‑Register **106** = linearer Faktor (8.24‑Festkomma): `1.0 = 0 dB = Vollausschlag`. **Nie > 1.0 schreiben.** Limit‑Register **74** bei 1.0 lassen. Jumper J5 (Voltage Limiter) schützt zusätzlich. Erster Ton immer leise, dann hochtasten.

## Zugang

Pi (RPiOS Lite): Hostname `beocreate` (früher `Pi3-beo`), IP im LAN (DHCP, zuletzt `<pi-ip>`), User `pi` (passwortloses sudo). Web‑UI: `http://<IP>/`.

## Repo‑Struktur

- `deploy/` — Deployment‑Artefakte (siehe Tabelle)
- `dsp/` — DSP‑Programm (EEPROM‑Image als XML)
- `_old_/` — Referenzmaterial (alter ChatGPT‑Chat, moOde‑v9‑Port); **gitignored**
