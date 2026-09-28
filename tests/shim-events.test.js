// End-to-end test of the event-driven audiocontrol shim against a fake go-librespot
// (HTTP /status + WS /events + /player/*) and a fake Beocreate (/sources/metadata).
// Run: cd tests && npm ci && npm test   (no Pi, no Spotify account needed)
"use strict";
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocketServer = require("websocket").server;

const GLR_PORT = 13678, BEO_PORT = 18080, SHIM_PORT = 18081;
const SHIM = process.argv[2] || path.join(__dirname, "..", "deploy", "audiocontrol-shim", "shim.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let status = null;            // null -> 204 (no session)
let statusGets = 0;
const playerCalls = [];
const pushes = [];
let wsConns = [];
let glrServer = null, wsServer = null;

function startGLR() {
	glrServer = http.createServer((req, res) => {
		if (req.method === "GET" && req.url === "/status") {
			statusGets++;
			if (!status) { res.writeHead(204); return res.end(); }
			const b = JSON.stringify(status);
			res.writeHead(200, { "Content-Type": "application/json" }); return res.end(b);
		}
		if (req.method === "POST" && req.url.startsWith("/player/")) { playerCalls.push(req.url); res.writeHead(200); return res.end(); }
		res.writeHead(404); res.end();
	});
	wsServer = new WebSocketServer({ httpServer: glrServer, autoAcceptConnections: false });
	wsServer.on("request", (r) => { if (r.resourceURL.pathname !== "/events") return r.reject(); const c = r.accept(null, r.origin); wsConns.push(c); c.on("close", () => { wsConns = wsConns.filter((x) => x !== c); }); });
	return new Promise((r) => glrServer.listen(GLR_PORT, "127.0.0.1", r));
}
function stopGLR() {
	return new Promise((r) => { wsConns.forEach((c) => c.drop()); wsConns = []; wsServer.shutDown(); glrServer.close(() => r()); glrServer.closeAllConnections && glrServer.closeAllConnections(); });
}
function emit(type, data) { wsConns.forEach((c) => c.sendUTF(JSON.stringify({ type, data: data || {} }))); }

const beo = http.createServer((req, res) => {
	let d = ""; req.on("data", (c) => d += c); req.on("end", () => { if (req.url === "/sources/metadata") pushes.push(JSON.parse(d)); res.writeHead(200); res.end("{}"); });
});

function get(p) { return new Promise((r) => http.get({ host: "127.0.0.1", port: SHIM_PORT, path: p }, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => r(JSON.parse(d))); })); }
function post(p) { return new Promise((r) => { const q = http.request({ host: "127.0.0.1", port: SHIM_PORT, path: p, method: "POST" }, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => r(JSON.parse(d))); }); q.end(); }); }

let failed = 0;
function check(name, cond, info) { console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(info))); if (!cond) failed++; }
const track = (n) => ({ name: "Song " + n, artist_names: ["Artist " + n], album_name: "Album " + n, album_cover_url: "http://img/" + n, uri: "spotify:track:" + n });

(async () => {
	await startGLR();
	await new Promise((r) => beo.listen(BEO_PORT, "127.0.0.1", r));
	const shim = spawn(process.execPath, [SHIM], { env: Object.assign({}, process.env, {
		SHIM_PORT: String(SHIM_PORT), SHIM_GLR_API: "http://127.0.0.1:" + GLR_PORT, SHIM_BEO_API: "http://127.0.0.1:" + BEO_PORT,
		NODE_PATH: path.join(__dirname, "node_modules") }), stdio: ["ignore", "pipe", "pipe"] });
	let shimLog = ""; shim.stdout.on("data", (d) => shimLog += d); shim.stderr.on("data", (d) => shimLog += d);
	try {
		await sleep(800);
		check("1 connects to /events and syncs once (no session -> 204)", wsConns.length === 1 && statusGets === 1 && pushes.length === 0, { ws: wsConns.length, statusGets, pushes });

		status = { stopped: false, paused: false, track: track("A") };
		emit("will_play"); emit("metadata", track("A")); emit("playing");
		await sleep(400);
		check("2 metadata+playing burst -> exactly one push 'playing Song A'", pushes.length === 1 && pushes[0].playerState === "playing" && pushes[0].title === "Song A", pushes);
		const getsAfterBurst = statusGets;
		check("2b burst reads are serialised (<= 3 reads for 2 sync events)", getsAfterBurst - 1 <= 3, { reads: getsAfterBurst - 1 });

		emit("volume", { value: 10 }); emit("seek", { position: 1000 });
		await sleep(300);
		check("3 volume/seek events cause no /status read", statusGets === getsAfterBurst, { statusGets, getsAfterBurst });

		const ps = await get("/api/player/status"), md = await get("/api/track/metadata");
		check("4 audiocontrol2 pull API reflects playing Song A", ps.players.length === 1 && ps.players[0].state === "playing" && md.title === "Song A", { ps, md });

		const before = statusGets; await sleep(3000);
		check("5 idle 3 s -> no polling", statusGets === before, { statusGets, before });

		status.paused = true; emit("paused");
		await sleep(300);
		check("6 paused event -> push 'paused'", pushes.length === 2 && pushes[1].playerState === "paused", pushes);

		const r = await post("/api/player/play");
		await sleep(100);
		check("7 transport play -> go-librespot /player/resume", r.ok === true && playerCalls[playerCalls.length - 1] === "/player/resume", { r, playerCalls });

		status.paused = false; status.track = track("B"); emit("metadata", track("B")); emit("playing");
		await sleep(300);
		check("8 track change -> push 'playing Song B'", pushes[pushes.length - 1].title === "Song B" && pushes[pushes.length - 1].playerState === "playing", pushes.slice(-1));

		const n = pushes.length;
		await stopGLR();
		await sleep(500);
		check("9 go-librespot gone -> push 'stopped' once", pushes.length === n + 1 && pushes[n].playerState === "stopped", pushes.slice(n));
		await sleep(2500);
		check("9b no further pushes while it is down", pushes.length === n + 1, pushes.slice(n));

		await startGLR();
		const t0 = Date.now();
		while (wsConns.length === 0 && Date.now() - t0 < 12000) await sleep(100);
		await sleep(400);
		check("10 reconnects (<= 10 s backoff) and resyncs -> push 'playing Song B'", wsConns.length === 1 && pushes[pushes.length - 1].playerState === "playing" && pushes[pushes.length - 1].title === "Song B", { reconnectMs: Date.now() - t0, last: pushes.slice(-1) });
		console.log("    reconnect took " + (Date.now() - t0) + " ms");

		status = null; emit("inactive");
		await sleep(300);
		check("11 device deselected (inactive, 204) -> push 'stopped'", pushes[pushes.length - 1].playerState === "stopped" && (await get("/api/player/status")).players.length === 0, pushes.slice(-1));

		const h = await get("/health");
		check("12 /health reports the event stream", h.spotify_events === true, h);
	} finally {
		shim.kill("SIGTERM");
		await sleep(300);
		console.log("--- shim log ---\n" + shimLog.trim());
		console.log(failed ? failed + " FAILED" : "ALL PASSED");
		process.exit(failed ? 1 : 0);
	}
})();
