// Spotify-Connect-Quelle für Beocreate (go-librespot-basiert)
// ------------------------------------------------------------
// Minimaler Ersatz für die ursprüngliche HiFiBerryOS-„spotify"-Extension
// (die audiocontrol2/librespot-Login voraussetzte). Diese Extension:
//   - registriert „spotify" als Quelle (Zustand + Metadaten liefert der
//     audiocontrol2-Shim auf :81, der go-librespot beobachtet),
//   - bietet in den Quellen-Einstellungen einen An/Aus-Schalter, der den
//     systemd-Dienst „go-librespot" startet bzw. stoppt.
//
// usesHifiberryControl:true => Transport aus dem UI läuft über den Shim an
// go-librespot; zugleich pausiert die native stopOthers-Logik Spotify
// automatisch, sobald TOSLINK aktiv wird.

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
	// enable/disable sorgt zusätzlich für die Persistenz über Neustarts.
	var cmd = enable ? ("systemctl enable --now " + SERVICE) : ("systemctl disable --now " + SERVICE);
	exec(cmd, function(error) {
		if (error && debug) console.error("Spotify: konnte " + SERVICE + " nicht " + (enable ? "starten" : "stoppen") + ": " + error);
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
			if (debug) console.log("Spotify (go-librespot) ist jetzt " + (active ? "an" : "aus") + ".");
		});
	}

});

module.exports = {
	version: version,
	// Quelle ist „aktiviert", solange der go-librespot-Dienst läuft.
	isEnabled: function(callback) { serviceActive(function(active) { if (callback) callback(active); }); }
};
