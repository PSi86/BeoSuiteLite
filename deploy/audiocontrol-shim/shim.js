#!/usr/bin/env node
"use strict";

// AudioControl2 shim for Beocreate 2  (+ go-librespot/Spotify integration)
// ------------------------------------------------------------------------
// Beocreate 2 was written for HiFiBerryOS and expects its "audiocontrol2"
// daemon at http://127.0.1.1:81. This shim provides the REST subset that the
// "sources"/"sound" extensions require — lean, Node built-ins plus the
// "websocket" client that Beocreate's own node_modules already carries
// (/opt/beocreate/node_modules) — and additionally handles the Spotify
// integration via go-librespot.
//
// audiocontrol2 REST (used by Beocreate):
//   - GET  /api/player/status    -> { players: [...], last_updated }
//   - GET  /api/track/metadata   -> metadata of the active source (or {})
//   - GET  /api/volume           -> { percent }   (live from ALSA "DSPVolume")
//   - POST /api/player/<cmd>      -> transport (play/pause/playpause/stop/next/previous)
//   - POST /api/player/activate/<name> · /api/track/love|unlove
//
// Spotify (go-librespot):
//   - The shim listens to go-librespot's event stream (WebSocket :3678/events).
//     On every (re)connect and on each state/track event it reads one
//     consistent snapshot (GET :3678/status) and, if anything changed, forwards
//     state + metadata as an audiocontrol2 push to Beocreate
//     (POST :80/sources/metadata -> processAudioControlMetadata). No timer runs
//     while nothing happens.
//   - A restarted Beocreate needs no re-push: after registering its sources it
//     pulls /api/player/status + /api/track/metadata from here itself.
//   - Transport commands from the Beocreate UI arrive here as
//     POST /api/player/<cmd> and are forwarded to go-librespot
//     (:3678/player/<cmd>).
//   - The corresponding source is registered by the Beocreate "spotify"
//     extension (usesHifiberryControl:true). This lets the native stopOthers
//     logic pause Spotify automatically as soon as TOSLINK becomes active.
//
// VOLUME: go-librespot's own (digital) volume is NOT reported to Beocreate.
// The DSP master (DSPVolume/reg 106) remains the sole volume control —
// /api/volume always returns the DSPVolume value.

const http = require("http");
const { execFile } = require("child_process");
const WebSocketClient = require("websocket").client;

const PORT = parseInt(process.env.SHIM_PORT || "81", 10);
const HOST = "0.0.0.0";                   // LAN access is blocked in the systemd unit
const ALSA_MIXER = "DSPVolume";
const GLR_API = process.env.SHIM_GLR_API || "http://127.0.0.1:3678";  // go-librespot API
const GLR_EVENTS = GLR_API.replace(/^http/, "ws") + "/events";
const BEO_API = process.env.SHIM_BEO_API || "http://127.0.0.1:80";    // Beocreate server (bus push)
const RECONNECT_MIN_MS = 1000;            // event stream reconnect backoff
const RECONNECT_MAX_MS = 10000;           // (go-librespot restarted or switched off)
const DEBUG = process.env.SHIM_DEBUG === "1";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const players = {};        // name(lowercased) -> audiocontrol2 player object
let currentMetadata = {};  // now-playing in audiocontrol2 format
let lastUpdated = Date.now();

function touch() { lastUpdated = Date.now(); }

function log(/* ...args */) { if (DEBUG) console.error.apply(console, ["[shim]"].concat([].slice.call(arguments))); }

// ---------------------------------------------------------------------------
// HTTP helpers
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

// Outbound JSON request (to go-librespot / Beocreate). Robust, never crashes.
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

// Reads the current volume live from the ALSA "DSPVolume" control.
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

// audiocontrol2 transport command -> go-librespot endpoint.
const TRANSPORT_MAP = { play: "resume", pause: "pause", playpause: "playpause", stop: "pause", next: "next", previous: "prev" };

let spotifyLastKey = null;
let spotifyLastState = "stopped";

function deriveSpotifyState(s) {
	if (!s || s.stopped || !s.track) return "stopped";
	if (s.paused) return "paused";
	return "playing";
}

function pushMetadataToBeocreate(meta) {
	httpJSON("POST", BEO_API + "/sources/metadata", meta, (err) => {
		if (err) log("push to Beocreate failed:", err.message);
	});
}

// No session / go-librespot gone: report "stopped" once.
function markSpotifyStopped() {
	if (spotifyLastState !== "stopped") {
		spotifyLastState = "stopped"; spotifyLastKey = "stopped||";
		delete players["spotify"];
		if (currentMetadata.playerName === "spotify") currentMetadata = {};
		touch();
		pushMetadataToBeocreate({ playerName: "spotify", playerState: "stopped" });
	}
}

// Events say THAT something changed; the snapshot says WHAT the state is now.
// Reading /status per event keeps a single, consistent derivation (the
// "paused"/"playing" payloads carry no track, "metadata" can precede
// "playing"). Reads are serialised so an older response can never overwrite a
// newer one: an event arriving mid-read just schedules one more read.
let syncInFlight = false;
let syncAgain = false;

function syncSpotify() {
	if (syncInFlight) { syncAgain = true; return; }
	syncInFlight = true;
	httpJSON("GET", GLR_API + "/status", null, (err, code, status) => {
		// 204 = go-librespot runs but has no session.
		if (err || code !== 200 || !status) markSpotifyStopped();
		else applySpotifyStatus(status);
		syncInFlight = false;
		if (syncAgain) { syncAgain = false; syncSpotify(); }
	});
}

function applySpotifyStatus(status) {
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
	if (key === spotifyLastKey) return;
	spotifyLastKey = key; spotifyLastState = state;

	if (state === "stopped") {
		delete players["spotify"];
		if (currentMetadata.playerName === "spotify") currentMetadata = {};
	} else {
		players["spotify"] = {
			name: "spotify",
			state: state,
			supported_commands: ["play", "pause", "next", "previous"],
			title: meta.title,
			artist: meta.artist
		};
		currentMetadata = meta; // keep /api/track/metadata consistent
	}
	touch();
	pushMetadataToBeocreate(meta);
}

// --- event stream --------------------------------------------------------------

// Events that can change state or track; volume/seek/repeat/shuffle cannot.
const SYNC_EVENTS = ["active", "inactive", "metadata", "playing", "paused", "stopped",
	"not_playing", "playback_error", "playback_ready"];

let eventsConn = null;
let eventsConnecting = false;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;

function connectEvents() {
	if (eventsConn || eventsConnecting) return;
	clearTimeout(reconnectTimer); reconnectTimer = null;
	eventsConnecting = true;
	const client = new WebSocketClient();
	client.on("connectFailed", (err) => {
		eventsConnecting = false;
		log("event stream: connect failed:", err && err.message);
		markSpotifyStopped();
		scheduleReconnect();
	});
	client.on("connect", (conn) => {
		eventsConnecting = false;
		eventsConn = conn;
		reconnectDelay = RECONNECT_MIN_MS;
		console.log("[shim] connected to go-librespot events (" + GLR_EVENTS + ")");
		syncSpotify(); // go-librespot sends no snapshot on connect
		conn.on("message", (msg) => {
			if (msg.type !== "utf8") return;
			let ev = null;
			try { ev = JSON.parse(msg.utf8Data); } catch (e) { return; }
			log("event:", ev && ev.type);
			if (ev && SYNC_EVENTS.indexOf(ev.type) !== -1) syncSpotify();
		});
		conn.on("error", (e) => log("event stream error:", e && e.message)); // "close" follows
		conn.on("close", () => {
			eventsConn = null;
			console.log("[shim] go-librespot event stream closed - reconnecting");
			markSpotifyStopped();
			scheduleReconnect();
		});
	});
	client.connect(GLR_EVENTS);
}

function scheduleReconnect() {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(() => { reconnectTimer = null; connectEvents(); }, reconnectDelay);
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// Forward a transport command to go-librespot.
function forwardTransport(command, callback) {
	const glrCmd = TRANSPORT_MAP[command];
	if (!glrCmd) return callback(false);
	httpJSON("POST", GLR_API + "/player/" + glrCmd, null, (err, code) => {
		if (err) { log("transport to go-librespot failed:", err.message); return callback(false); }
		// The resulting state change arrives as an event. If the stream is down
		// (go-librespot just came back), don't wait for the backoff.
		if (!eventsConn) connectEvents();
		callback(code >= 200 && code < 300);
	});
}

// ---------------------------------------------------------------------------
// Internal player registry (alternative hook, e.g. for further sources)
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
		if (urlPath === "/health" || urlPath === "/") return sendJSON(res, 200, { status: "ok", players: Object.keys(players), last_updated: lastUpdated, spotify_events: !!eventsConn });
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
	catch (e) { try { sendJSON(res, 500, { error: String(e && e.message || e) }); } catch (_) {} console.error("[shim] error at", req.method, req.url, "-", e && e.message); }
});

server.on("error", (e) => {
	console.error("[shim] server error:", e && e.message);
	if (e && e.code === "EADDRINUSE") { console.error("[shim] port " + PORT + " in use - is audiocontrol2 still running?"); process.exit(1); }
});

server.listen(PORT, HOST, () => {
	console.log("[shim] AudioControl2 shim listening on http://" + HOST + ":" + PORT);
	connectEvents();
});

// The event stream is deliberately not closed first: its "close" handler would
// report Spotify as stopped although only the shim restarts.
function shutdown() {
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 2000).unref(); // keep-alive clients
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
