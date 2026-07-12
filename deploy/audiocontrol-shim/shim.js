#!/usr/bin/env node
"use strict";

// AudioControl2-Shim für Beocreate 2
// -----------------------------------
// Beocreate 2 wurde für HiFiBerryOS geschrieben und erwartet den dortigen
// "audiocontrol2"-Daemon unter http://127.0.1.1:81. Die Extensions "sources"
// und "sound" fragen dort Quellen-Status, Now-Playing-Metadaten und Lautstärke
// ab. audiocontrol2 selbst ist seit 2019 archiviert und wollen wir NICHT
// betreiben. Dieser Shim liefert exakt die von den Extensions benötigte
// REST-Teilmenge – schlank, ohne npm-Abhängigkeiten (nur Node-Builtins).
//
// Aktueller Funktionsumfang:
//   - GET  /api/player/status    -> { players: [...], last_updated }
//   - GET  /api/track/metadata   -> Metadaten der aktiven Quelle (oder {})
//   - GET  /api/volume           -> { percent }   (live aus ALSA "DSPVolume")
//   - POST /api/player/<cmd>      -> Transport (play/pause/playpause/stop/next/previous)
//   - POST /api/player/activate/<name>
//   - POST /api/track/love|unlove
//   - POST /api/volume           -> { percent }   (wird real via DSPVolume nicht genutzt)
//
// Erweiterungs-Naht für Spotify (Phase 5): ein separater go-librespot-Bridge-
// Prozess meldet Player-Status/Metadaten über die internen Endpunkte:
//   - POST   /internal/player    -> Player anlegen/aktualisieren
//   - DELETE /internal/player/<name>
// Dadurch erscheint Spotify als echte Quelle in der Beocreate-Quellenliste,
// ohne dass der Shim selbst go-librespot kennen muss.
//
// TOSLINK/Optical ist bewusst NICHT Teil dieses Shims: der optische Eingang
// wird nativ von der DSP-"toslink"-Extension verwaltet (DSP-Register 93/4841),
// nicht über audiocontrol2.

const http = require("http");
const { execFile } = require("child_process");

const PORT = 81;
const HOST = "0.0.0.0"; // deckt 127.0.1.1 (Beocreate-Fetches) und den LAN-Zugriff (spätere Cover-Art) ab
const ALSA_MIXER = "DSPVolume"; // von sigmatcpserver --alsa erzeugt, gespiegelt auf DSP-Register 106

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

// players: name(kleingeschrieben) -> audiocontrol2-Player-Objekt
//   { name, state, supported_commands, artist, title, ... }
const players = {};

// Aktuelle Now-Playing-Metadaten im audiocontrol2-Format.
let currentMetadata = {};

// Wird bei jeder Zustandsänderung aktualisiert; "sources" nutzt es zur
// Änderungserkennung.
let lastUpdated = Date.now();

function touch() {
	lastUpdated = Date.now();
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function sendJSON(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store"
	});
	res.end(body);
}

function readBody(req, callback) {
	let data = "";
	let tooLarge = false;
	req.on("data", (chunk) => {
		data += chunk;
		if (data.length > 1e6) { // 1 MB Schutzgrenze
			tooLarge = true;
			req.destroy();
		}
	});
	req.on("end", () => {
		if (tooLarge) return callback(null);
		if (!data) return callback({});
		try {
			callback(JSON.parse(data));
		} catch (e) {
			callback(null);
		}
	});
	req.on("error", () => callback(null));
}

// Liest die aktuelle Lautstärke live aus dem ALSA-Control "DSPVolume".
// audiocontrol2 lieferte hier den ALSA-Prozentwert; wir tun dasselbe, damit
// der von der sound-Extension gemeldete Wert konsistent bleibt.
function getVolumePercent(callback) {
	execFile("amixer", ["get", ALSA_MIXER], { timeout: 4000 }, (error, stdout) => {
		if (error || !stdout) return callback(null);
		const m = stdout.match(/\[(\d+)%\]/);
		if (!m) return callback(null);
		callback(parseInt(m[1], 10));
	});
}

// ---------------------------------------------------------------------------
// Interne Player-Verwaltung (Naht für die spätere go-librespot-Bridge)
// ---------------------------------------------------------------------------

function upsertPlayer(p) {
	if (!p || !p.name) return false;
	const key = String(p.name).toLowerCase();
	const existing = players[key] || {};
	players[key] = Object.assign(existing, p, { name: p.name });
	// Metadaten des zuletzt spielenden Players als Now-Playing übernehmen.
	if (p.state === "playing" && p.metadata) {
		currentMetadata = Object.assign({ playerName: p.name, playerState: "playing" }, p.metadata);
	}
	touch();
	return true;
}

function removePlayer(name) {
	const key = String(name).toLowerCase();
	if (players[key]) {
		delete players[key];
		if (currentMetadata.playerName && currentMetadata.playerName.toLowerCase() === key) {
			currentMetadata = {};
		}
		touch();
		return true;
	}
	return false;
}

// Forward-Hook für Transportbefehle. Solange keine steuerbare Quelle (Spotify)
// registriert ist, sind die Befehle No-Ops und werden mit 200 quittiert – die
// sources-Extension fällt dann sauber auf ihre eigene Behandlung zurück.
// Wird in Phase 5 mit dem go-librespot-API-Aufruf verdrahtet.
function forwardTransport(command, callback) {
	// TODO(Phase 5): an go-librespot-API weiterreichen (play/pause/next/previous).
	callback(true);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const PLAYER_COMMANDS = ["play", "pause", "playpause", "stop", "next", "previous"];

function handle(req, res) {
	const method = req.method.toUpperCase();
	const urlPath = req.url.split("?")[0].replace(/\/+$/, "") || "/";

	// --- GET-Endpunkte -----------------------------------------------------
	if (method === "GET") {
		if (urlPath === "/api/player/status") {
			return sendJSON(res, 200, { players: Object.values(players), last_updated: lastUpdated });
		}
		if (urlPath === "/api/track/metadata") {
			return sendJSON(res, 200, currentMetadata);
		}
		if (urlPath === "/api/volume") {
			return getVolumePercent((percent) => {
				if (percent == null) return sendJSON(res, 200, {});
				sendJSON(res, 200, { percent: percent });
			});
		}
		if (urlPath === "/health" || urlPath === "/") {
			return sendJSON(res, 200, { status: "ok", players: Object.keys(players).length, last_updated: lastUpdated });
		}
	}

	// --- POST-Endpunkte ----------------------------------------------------
	if (method === "POST") {
		// Transportbefehle: /api/player/<cmd>
		const cmdMatch = urlPath.match(/^\/api\/player\/([a-z]+)$/i);
		if (cmdMatch && PLAYER_COMMANDS.indexOf(cmdMatch[1].toLowerCase()) !== -1) {
			return forwardTransport(cmdMatch[1].toLowerCase(), (ok) => {
				sendJSON(res, ok ? 200 : 500, { command: cmdMatch[1].toLowerCase(), ok: ok });
			});
		}

		// Quelle aktivieren: /api/player/activate/<name>
		const actMatch = urlPath.match(/^\/api\/player\/activate\/(.+)$/i);
		if (actMatch) {
			// TODO(Phase 5): entsprechende go-librespot-Quelle aktivieren.
			return sendJSON(res, 200, { activated: decodeURIComponent(actMatch[1]) });
		}

		// Love/Unlove
		if (urlPath === "/api/track/love" || urlPath === "/api/track/unlove") {
			return sendJSON(res, 200, { ok: true });
		}

		// Lautstärke setzen (real ungenutzt – Beocreate steuert via ALSA DSPVolume).
		if (urlPath === "/api/volume") {
			return readBody(req, () => sendJSON(res, 200, { ok: true }));
		}

		// Interne Naht: Player anlegen/aktualisieren.
		if (urlPath === "/internal/player") {
			return readBody(req, (body) => {
				if (!body) return sendJSON(res, 400, { error: "invalid JSON" });
				const ok = upsertPlayer(body);
				sendJSON(res, ok ? 200 : 400, { ok: ok, players: Object.keys(players) });
			});
		}
	}

	// --- DELETE ------------------------------------------------------------
	if (method === "DELETE") {
		const delMatch = urlPath.match(/^\/internal\/player\/(.+)$/i);
		if (delMatch) {
			const ok = removePlayer(decodeURIComponent(delMatch[1]));
			return sendJSON(res, 200, { ok: ok });
		}
	}

	sendJSON(res, 404, { error: "not found", path: urlPath });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
	try {
		handle(req, res);
	} catch (e) {
		try { sendJSON(res, 500, { error: String(e && e.message || e) }); } catch (_) {}
		console.error("[shim] Fehler bei", req.method, req.url, "-", e && e.message);
	}
});

server.on("error", (e) => {
	console.error("[shim] Serverfehler:", e && e.message);
	if (e && e.code === "EADDRINUSE") {
		console.error("[shim] Port " + PORT + " ist belegt – läuft evtl. noch audiocontrol2?");
		process.exit(1);
	}
});

server.listen(PORT, HOST, () => {
	console.log("[shim] AudioControl2-Shim lauscht auf http://" + HOST + ":" + PORT);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
