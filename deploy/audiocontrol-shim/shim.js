#!/usr/bin/env node
"use strict";

// AudioControl2-Shim für Beocreate 2  (+ go-librespot/Spotify-Integration)
// -----------------------------------------------------------------------
// Beocreate 2 wurde für HiFiBerryOS geschrieben und erwartet dort den
// "audiocontrol2"-Daemon unter http://127.0.1.1:81. Dieser Shim liefert die
// von den Extensions "sources"/"sound" benötigte REST-Teilmesse — schlank,
// ohne npm-Abhängigkeiten (nur Node-Builtins) — und übernimmt zusätzlich die
// Spotify-Integration über go-librespot.
//
// audiocontrol2-REST (von Beocreate genutzt):
//   - GET  /api/player/status    -> { players: [...], last_updated }
//   - GET  /api/track/metadata   -> Metadaten der aktiven Quelle (oder {})
//   - GET  /api/volume           -> { percent }   (live aus ALSA "DSPVolume")
//   - POST /api/player/<cmd>      -> Transport (play/pause/playpause/stop/next/previous)
//   - POST /api/player/activate/<name> · /api/track/love|unlove
//
// Spotify (go-librespot):
//   - Der Shim POLLT go-librespot (GET :3678/status) und leitet Zustand +
//     Metadaten als audiocontrol2-Push an Beocreate weiter
//     (POST :80/sources/metadata -> processAudioControlMetadata).
//   - Transportbefehle aus dem Beocreate-UI kommen als POST /api/player/<cmd>
//     hier an und werden an go-librespot (:3678/player/<cmd>) weitergereicht.
//   - Die zugehörige Quelle wird von der Beocreate-"spotify"-Extension
//     registriert (usesHifiberryControl:true). Dadurch pausiert die native
//     stopOthers-Logik Spotify automatisch, sobald TOSLINK aktiv wird.
//
// LAUTSTÄRKE: go-librespots eigene (digitale) Lautstärke wird NICHT an
// Beocreate gemeldet. Der DSP-Master (DSPVolume/Reg 106) bleibt der alleinige
// Lautstärke-Regler — /api/volume liefert stets den DSPVolume-Wert.

const http = require("http");
const { execFile } = require("child_process");

const PORT = 81;
const HOST = "0.0.0.0";
const ALSA_MIXER = "DSPVolume";
const GLR_API = "http://127.0.0.1:3678";  // go-librespot API
const BEO_API = "http://127.0.0.1:80";    // Beocreate-Server (Bus-Push)
const SPOTIFY_POLL_MS = 1000;
const SPOTIFY_REPUSH_MS = 10000;          // periodisch neu pushen (überlebt Beocreate-Neustart)
const DEBUG = process.env.SHIM_DEBUG === "1";

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

const players = {};        // name(kleingeschrieben) -> audiocontrol2-Player-Objekt
let currentMetadata = {};  // Now-Playing im audiocontrol2-Format
let lastUpdated = Date.now();

function touch() { lastUpdated = Date.now(); }

function log(/* ...args */) { if (DEBUG) console.error.apply(console, ["[shim]"].concat([].slice.call(arguments))); }

// ---------------------------------------------------------------------------
// HTTP-Helfer
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
		if (data.length > 1e6) { tooLarge = true; req.destroy(); }
	});
	req.on("end", () => {
		if (tooLarge) return callback(null);
		if (!data) return callback({});
		try { callback(JSON.parse(data)); } catch (e) { callback(null); }
	});
	req.on("error", () => callback(null));
}

// Ausgehende JSON-Anfrage (an go-librespot / Beocreate). Robust, ohne Crash.
function httpJSON(method, url, body, callback) {
	let done = false;
	const finish = (err, code, parsed) => { if (!done) { done = true; if (callback) callback(err, code, parsed); } };
	try {
		const u = new URL(url);
		const data = body != null ? JSON.stringify(body) : null;
		const opts = {
			method: method,
			hostname: u.hostname,
			port: u.port,
			path: u.pathname + u.search,
			headers: { "Accept": "application/json" }
		};
		if (data) { opts.headers["Content-Type"] = "application/json"; opts.headers["Content-Length"] = Buffer.byteLength(data); }
		const r = http.request(opts, (res) => {
			let chunks = "";
			res.on("data", (c) => { chunks += c; });
			res.on("end", () => {
				let parsed = null;
				try { parsed = chunks ? JSON.parse(chunks) : null; } catch (e) {}
				finish(null, res.statusCode, parsed);
			});
		});
		r.setTimeout(3000, () => r.destroy(new Error("timeout")));
		r.on("error", (e) => finish(e));
		if (data) r.write(data);
		r.end();
	} catch (e) { finish(e); }
}

// Liest die Lautstärke live aus dem ALSA-Control "DSPVolume".
function getVolumePercent(callback) {
	execFile("amixer", ["get", ALSA_MIXER], { timeout: 4000 }, (error, stdout) => {
		if (error || !stdout) return callback(null);
		const m = stdout.match(/\[(\d+)%\]/);
		callback(m ? parseInt(m[1], 10) : null);
	});
}

// ---------------------------------------------------------------------------
// go-librespot / Spotify
// ---------------------------------------------------------------------------

// audiocontrol2-Transportbefehl -> go-librespot-Endpunkt.
const TRANSPORT_MAP = { play: "resume", pause: "pause", playpause: "playpause", stop: "pause", next: "next", previous: "prev" };

let spotifyLastKey = null;
let spotifyLastState = "stopped";
let spotifyLastPush = 0;

function deriveSpotifyState(s) {
	if (!s || s.stopped || !s.track) return "stopped";
	if (s.paused) return "paused";
	return "playing";
}

function pushMetadataToBeocreate(meta) {
	spotifyLastPush = Date.now();
	httpJSON("POST", BEO_API + "/sources/metadata", meta, (err) => {
		if (err) log("Push an Beocreate fehlgeschlagen:", err.message);
	});
}

function pollSpotify() {
	httpJSON("GET", GLR_API + "/status", null, (err, code, status) => {
		if (err || code !== 200 || !status) {
			// go-librespot nicht erreichbar / keine Session: ggf. auf "stopped" zurücksetzen.
			if (spotifyLastState !== "stopped") {
				spotifyLastState = "stopped"; spotifyLastKey = "stopped||";
				delete players["spotify"]; touch();
				pushMetadataToBeocreate({ playerName: "spotify", playerState: "stopped" });
			}
			return;
		}
		const state = deriveSpotifyState(status);
		const track = status.track || {};
		const meta = {
			playerName: "spotify",
			playerState: state,
			title: track.name || "",
			artist: Array.isArray(track.artist_names) ? track.artist_names.join(", ") : (track.artist_names || ""),
			albumTitle: track.album_name || "",
			artUrl: "",
			externalArtUrl: track.album_cover_url || "",
			streamUrl: track.uri || "",
			loved: false,
			loveSupported: false
		};
		const key = state + "|" + meta.title + "|" + meta.artist + "|" + meta.albumTitle;
		const changed = key !== spotifyLastKey;
		const stale = (Date.now() - spotifyLastPush) > SPOTIFY_REPUSH_MS;

		if (state === "stopped") {
			if (changed) {
				spotifyLastKey = key; spotifyLastState = state;
				delete players["spotify"];
				if (currentMetadata.playerName === "spotify") currentMetadata = {};
				touch();
				pushMetadataToBeocreate(meta);
			}
			return;
		}

		if (changed) {
			players["spotify"] = {
				name: "spotify",
				state: state,
				supported_commands: ["play", "pause", "next", "previous"],
				title: meta.title,
				artist: meta.artist
			};
			currentMetadata = meta; // /api/track/metadata konsistent halten
			touch();
		}
		if (changed || stale) {
			spotifyLastKey = key; spotifyLastState = state;
			pushMetadataToBeocreate(meta);
		}
	});
}

// Transportbefehl an go-librespot weiterreichen.
function forwardTransport(command, callback) {
	const glrCmd = TRANSPORT_MAP[command];
	if (!glrCmd) return callback(false);
	httpJSON("POST", GLR_API + "/player/" + glrCmd, null, (err, code) => {
		if (err) { log("Transport an go-librespot fehlgeschlagen:", err.message); return callback(false); }
		setTimeout(pollSpotify, 250); // Zustand zügig nachziehen
		callback(code >= 200 && code < 300);
	});
}

// ---------------------------------------------------------------------------
// Interne Player-Verwaltung (alternative Naht, z. B. für weitere Quellen)
// ---------------------------------------------------------------------------

function upsertPlayer(p) {
	if (!p || !p.name) return false;
	const key = String(p.name).toLowerCase();
	players[key] = Object.assign(players[key] || {}, p, { name: p.name });
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
		if (currentMetadata.playerName && currentMetadata.playerName.toLowerCase() === key) currentMetadata = {};
		touch();
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const PLAYER_COMMANDS = ["play", "pause", "playpause", "stop", "next", "previous"];

function handle(req, res) {
	const method = req.method.toUpperCase();
	const urlPath = req.url.split("?")[0].replace(/\/+$/, "") || "/";

	if (method === "GET") {
		if (urlPath === "/api/player/status") return sendJSON(res, 200, { players: Object.values(players), last_updated: lastUpdated });
		if (urlPath === "/api/track/metadata") return sendJSON(res, 200, currentMetadata);
		if (urlPath === "/api/volume") {
			return getVolumePercent((percent) => sendJSON(res, 200, percent == null ? {} : { percent: percent }));
		}
		if (urlPath === "/health" || urlPath === "/") return sendJSON(res, 200, { status: "ok", players: Object.keys(players), last_updated: lastUpdated });
	}

	if (method === "POST") {
		const cmdMatch = urlPath.match(/^\/api\/player\/([a-z]+)$/i);
		if (cmdMatch && PLAYER_COMMANDS.indexOf(cmdMatch[1].toLowerCase()) !== -1) {
			return forwardTransport(cmdMatch[1].toLowerCase(), (ok) => sendJSON(res, ok ? 200 : 500, { command: cmdMatch[1].toLowerCase(), ok: ok }));
		}
		const actMatch = urlPath.match(/^\/api\/player\/activate\/(.+)$/i);
		if (actMatch) return sendJSON(res, 200, { activated: decodeURIComponent(actMatch[1]) });
		if (urlPath === "/api/track/love" || urlPath === "/api/track/unlove") return sendJSON(res, 200, { ok: true });
		if (urlPath === "/api/volume") return readBody(req, () => sendJSON(res, 200, { ok: true }));
		if (urlPath === "/internal/player") {
			return readBody(req, (body) => {
				if (!body) return sendJSON(res, 400, { error: "invalid JSON" });
				sendJSON(res, upsertPlayer(body) ? 200 : 400, { ok: true, players: Object.keys(players) });
			});
		}
	}

	if (method === "DELETE") {
		const delMatch = urlPath.match(/^\/internal\/player\/(.+)$/i);
		if (delMatch) return sendJSON(res, 200, { ok: removePlayer(decodeURIComponent(delMatch[1])) });
	}

	sendJSON(res, 404, { error: "not found", path: urlPath });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
	try { handle(req, res); }
	catch (e) { try { sendJSON(res, 500, { error: String(e && e.message || e) }); } catch (_) {} console.error("[shim] Fehler bei", req.method, req.url, "-", e && e.message); }
});

server.on("error", (e) => {
	console.error("[shim] Serverfehler:", e && e.message);
	if (e && e.code === "EADDRINUSE") { console.error("[shim] Port " + PORT + " belegt – läuft evtl. noch audiocontrol2?"); process.exit(1); }
});

server.listen(PORT, HOST, () => {
	console.log("[shim] AudioControl2-Shim lauscht auf http://" + HOST + ":" + PORT);
	setInterval(pollSpotify, SPOTIFY_POLL_MS);  // Spotify-Zustand pollen
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
