// Spotify Connect source for Beocreate (go-librespot based)
// ----------------------------------------------------------
// Minimal replacement for the original HiFiBerryOS "spotify" extension
// (which required audiocontrol2/librespot login). This extension:
//   - registers "spotify" as a source (state + metadata are provided by the
//     audiocontrol2 shim on :81, which observes go-librespot),
//   - offers an on/off switch in the source settings that starts/stops the
//     systemd service "go-librespot".
//
// usesHifiberryControl:true => transport from the UI runs via the shim to
// go-librespot; at the same time the native stopOthers logic pauses Spotify
// automatically as soon as TOSLINK becomes active.

var exec = require("child_process").exec;
var version = require("./package.json").version;
var debug = beo.debug;

var sources = null;
var SERVICE = "go-librespot";

function serviceActive(callback) {
	exec("systemctl is-active " + SERVICE, function(error, stdout) {
		callback(((stdout || "").trim() === "active"));
	});
}

function setService(enable, callback) {
	// enable/disable also ensures persistence across reboots.
	var cmd = enable ? ("systemctl enable --now " + SERVICE) : ("systemctl disable --now " + SERVICE);
	exec(cmd, function(error) {
		if (error && debug) console.error("Spotify: could not " + (enable ? "start" : "stop") + " " + SERVICE + ": " + error);
		serviceActive(callback);
	});
}

beo.bus.on('general', function(event) {

	if (event.header == "startup") {
		if (beo.extensions.sources &&
			beo.extensions.sources.setSourceOptions &&
			beo.extensions.sources.sourceActivated &&
			beo.extensions.sources.sourceDeactivated) {
			sources = beo.extensions.sources;
			serviceActive(function(active) {
				sources.setSourceOptions("spotify", {
					enabled: active,
					transportControls: true,
					usesHifiberryControl: true,
					aka: "spotify",
					sortName: "Spotify"
				});
				if (debug) console.log("Spotify source registered (go-librespot), enabled=" + active + ".");
			});
		}
	}

	if (event.header == "activatedExtension" && event.content.extension == "spotify") {
		serviceActive(function(active) {
			beo.bus.emit("ui", {target: "spotify", header: "spotifySettings", content: {enabled: active}});
		});
	}

});

beo.bus.on('spotify', function(event) {

	if (event.header == "spotifyEnabled" && event.content && event.content.enabled != undefined) {
		setService(event.content.enabled ? true : false, function(active) {
			beo.bus.emit("ui", {target: "spotify", header: "spotifySettings", content: {enabled: active}});
			if (sources) {
				sources.setSourceOptions("spotify", {enabled: active});
				if (!active) sources.sourceDeactivated("spotify", "stopped");
			}
			if (debug) console.log("Spotify (go-librespot) is now " + (active ? "on" : "off") + ".");
		});
	}

});

module.exports = {
	version: version,
	// The source is "enabled" as long as the go-librespot service is running.
	isEnabled: function(callback) { serviceActive(function(active) { if (callback) callback(active); }); }
};
