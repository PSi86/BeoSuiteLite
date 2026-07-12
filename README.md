# Beocreate 4‑Channel Amplifier — Standalone‑Setup auf Raspberry Pi OS Lite

Sauberer Neuaufbau, um den **HiFiBerry Beocreate 4‑Channel Amplifier** (Analog Devices ADAU1451 SigmaDSP) an einem Raspberry Pi 3B voll nutzbar zu machen — mit der originalen **Beocreate‑2‑Weboberfläche** (EQ, Kanäle, Lautstärke, Optical/TOSLINK), ohne das eingestellte HiFiBerryOS und ohne den fragilen 2019er‑`audiocontrol2`‑Daemon.

**Primärquelle:** optischer Eingang (TOSLINK) vom PC. **Sekundär:** Spotify Connect (via go‑librespot, vollständig integriert).

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
audiocontrol-shim (Node) :81  ← audiocontrol2-Ersatz + Spotify-Anbindung
        ├─ GET  /api/player/status · /api/track/metadata · /api/volume
        ├─ POST /api/player/<cmd>  → mappt auf go-librespot :3678/player/<cmd>
        ├─ pollt go-librespot :3678/status  → Zustand+Metadaten
        └─ pusht  Beocreate :80/sources/metadata (Now-Playing)
        │
go-librespot (Go) :3678       ← Spotify Connect ("Beocreate")
        └─ ALSA plughw:sndrpihifiberry → I2S → DSP → DAC (bekommt EQ)
        │
Beocreate 2 UI (Node 20) :80  ← EQ / 4-Kanal / Optical / Spotify / Lautstärke / Quellen
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
12. **Spotify‑Integration (go‑librespot):** `go-librespot` (arm64, `zeroconf_backend: avahi` → vermeidet 5353‑Konflikt) läuft als Dienst und spielt via `plughw:sndrpihifiberry` → I2S → DSP → Amp (bekommt also den EQ). Der **Shim pollt** `go-librespot` (`GET :3678/status`) und **pusht** Zustand+Metadaten im audiocontrol2‑Format an Beocreate (`POST :80/sources/metadata` → `processAudioControlMetadata`; dieser Push‑Weg existiert im beo‑server über die Route `/:extension/:header`). **Transport** aus dem UI läuft umgekehrt: `POST :81/api/player/<cmd>` → Shim → `go-librespot :3678/player/<cmd>` (play→resume …). Die **Quellen‑Kachel + das Icon** kommen aus `beo-extensions/spotify/menu.html` (`<div class="menu-screen source" data-icon="spotify.svg">`) — eine minimale, entkoppelte Extension (statt der HiFiBerryOS‑Variante mit `arm7`/Login). Ein **An/Aus‑Schalter** startet/stoppt den `go-librespot`‑Dienst (`systemctl enable/disable --now`).
13. **Automatische Quellen‑Priorität (ohne Extra‑Skript):** Weil die Spotify‑Quelle `usesHifiberryControl:true` ist, pausiert Beocreates **native `stopOthers`‑Logik** Spotify automatisch, sobald TOSLINK aktiv wird (`audioControl("pause")` → Shim → go‑librespot). Umgekehrt hat die edge‑basierte toslink‑Erkennung einen **Re‑Assert** erhalten (`deploy/patches/toslink-source-reassert.patch`): liegt das optische Signal noch an und ist **keine** Quelle aktiv (Spotify pausiert), wird Optical erneut aktiviert — sonst bliebe Now‑Playing leer, da ohne Signalflanke nichts triggert. **Polling‑Hinweis:** Zwei zyklische Reads bleiben bewusst — toslink liest DSP‑Reg 93 alle 2 s (der DSP bietet keinen Push; unvermeidbar), der Shim pollt go‑librespot alle 1 s (lokal, vernachlässigbar; bewusst kein WebSocket).

## Deployment‑Artefakte (`deploy/`)

| Datei | Ziel auf dem Pi | Zweck |
|---|---|---|
| `systemd/beocreate2.service` | `/etc/systemd/system/` | Beocreate‑2‑UI (Node, als root); `After/Wants audiocontrol-shim`; ohne Debug‑Flag (Produktion). |
| `systemd/sigmatcpserver.service.d/override.conf` | `/etc/systemd/system/sigmatcpserver.service.d/` | Flags‑Override (8086 + DSPVolume) |
| `audiocontrol-shim/shim.js` | `/opt/beocreate/audiocontrol-shim/` | audiocontrol2‑Ersatz auf `:81` + go‑librespot‑Anbindung (Poll/Push/Transport) |
| `audiocontrol-shim/audiocontrol-shim.service` | `/etc/systemd/system/` | systemd‑Unit für den Shim (als root, `enable`d) |
| `go-librespot/config.yml` | `~pi/.config/go-librespot/` | Spotify‑Connect‑Config (avahi, plughw, API :3678, sichere Lautstärke) |
| `go-librespot/go-librespot.service` | `/etc/systemd/system/` | Dienst (User `pi`, `enable`d); Binary `v0.7.4` arm64 nach `/opt/go-librespot/` |
| `beo-extensions/spotify/` | `/opt/beocreate/beo-extensions/spotify/` | minimale Spotify‑Quellen‑Extension (Kachel/Icon/An‑Aus‑Schalter); ersetzt Original (Backup: `~pi/beo-extension-spotify-orig`) |
| `beo-extensions/toslink/index.js` | `/opt/beocreate/beo-extensions/toslink/` | **vendored** (Upstream + Null‑Check + Source‑Re‑Assert) |
| `etc-beocreate/system.json` | `/etc/beocreate/` | cardType/**cardFeatures `["dsp","toslink"]`**/Port/Extension‑Allowlist (inkl. `spotify`) |
| `etc-beocreate/sound.json` | `/etc/beocreate/` | `mixer: DSPVolume` (Lautstärke‑Fix) |
| `etc-beocreate/toslink.json` | `/etc/beocreate/` | `toslinkEnabled: true` |
| `etc-modprobe.d/spidev.conf` | `/etc/modprobe.d/` | `bufsiz=131072` (greift bei Boot NICHT — siehe cmdline) |
| `cmdline.txt.additions` | `/boot/firmware/cmdline.txt` | **`spidev.bufsiz=131072`** (wirksam bei Boot; nötig fürs DSP‑Neuflashen) |
| `opt-beocreate/beo-guard.js` | `/opt/beocreate/` | globaler Fehler‑Guard (Preload) |
| `patches/sound-audiocontrol-catch.patch` | `beo-extensions/sound/index.js` | `.catch` am audiocontrol‑Fetch |
| `patches/toslink-sigmatcp-nullcheck.patch` · `patches/toslink-source-reassert.patch` | Doku | zwei toslink‑Änderungen (im vendored `index.js` enthalten) |
| `config.txt.additions` | `/boot/firmware/config.txt` | hifiberry‑dac + SPI/I2S/I2C + audio=off |
| `../dsp/beocreate-universal-11.xml` | `~/` → EEPROM | DSP‑Programm (checksum `97C9C5…`) |

Beocreate 2 selbst wird aus `github.com/bang-olufsen/create` nach `/opt/beocreate` deployt (Inhalt von `Beocreate2/` + `beocreate_essentials/`); npm‑Deps in `/opt/beocreate/node_modules` mit `express@^4.18`.

## Aktueller Stand

**Funktioniert (nach Reboot verifiziert):** DSP self‑bootet · TOSLINK/PC hörbar, Stereo korrekt · Beocreate‑2‑UI auf `:80` (EQ, Kanäle, Optical, Beosonic, Presets) · **Master‑Lautstärke‑Regler** · **audiocontrol2‑Shim auf `:81`** · **Quellen‑Liste zeigt „Optical Input" + „Spotify Connect"** (je mit Icon, korrekter Aktiv‑Anzeige/Umschaltung) · **Spotify Connect** vollständig: Gerät „Beocreate" in der App, Now‑Playing (Titel/Interpret/Album/Cover), Transport (Play/Pause/Skip), An/Aus‑Schalter, automatische TOSLINK‑Priorität · **Reboot‑fest** (alle Dienste `enable`d, sichere Boot‑Lautstärke, `spidev.bufsiz=131072` greift).

**Offen:**
- **Power‑Cycle‑Test** (Strom weg/an) als finale Absicherung — Reboot ist bereits ok.
- Nice‑to‑have: Seek (Springen im Titel) für Spotify ist noch nicht verdrahtet.

## ⚠️ Lautstärke‑Sicherheit

DSP‑Register **106** = linearer Faktor (8.24‑Festkomma): `1.0 = 0 dB = Vollausschlag`. **Nie > 1.0 schreiben.** Limit‑Register **74** bei 1.0 lassen. Jumper J5 (Voltage Limiter) schützt zusätzlich. Erster Ton immer leise, dann hochtasten.

## Zugang

Pi (RPiOS Lite): Hostname `beocreate` (früher `Pi3-beo`), IP im LAN (DHCP, zuletzt `<pi-ip>`), User `pi` (passwortloses sudo). Web‑UI: `http://<IP>/`.

## Repo‑Struktur

- `deploy/` — Deployment‑Artefakte (siehe Tabelle)
- `dsp/` — DSP‑Programm (EEPROM‑Image als XML)
- `_old_/` — Referenzmaterial (alter ChatGPT‑Chat, moOde‑v9‑Port); **gitignored**
