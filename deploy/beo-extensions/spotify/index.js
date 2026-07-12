// Spotify-Connect-Quelle für Beocreate (go-librespot-basiert)
// ------------------------------------------------------------
// Minimaler Ersatz für die ursprüngliche HiFiBerryOS-„spotify"-Extension
// (die audiocontrol2/librespot-Login voraussetzte). Hier registriert die
// Extension lediglich „spotify" als Quelle. Zustand + Metadaten liefert der
// audiocontrol2-Shim (:81), der go-librespot pollt und per
// POST /sources/metadata an Beocreate pusht.
//
// usesHifiberryControl:true => Transportbefehle aus dem UI laufen über den Shim
// (POST :81/api/player/<cmd>) an go-librespot. Zugleich pausiert dadurch die
// native stopOthers-Logik der sources-Extension Spotify automatisch, sobald
// TOSLINK aktiv wird (automatische Quellen-Priorität, kein Extra-Skript nötig).

var version = require("./package.json").version;
var debug = beo.debug;

var sources = null;

beo.bus.on('general', function(event) {

	if (event.header == "startup") {
		if (beo.extensions.sources &&
			beo.extensions.sources.setSourceOptions &&
			beo.extensions.sources.sourceActivated &&
			beo.extensions.sources.sourceDeactivated) {
			sources = beo.extensions.sources;
			sources.setSourceOptions("spotify", {
				enabled: true,
				transportControls: true,
				usesHifiberryControl: true,
				aka: "spotify",
				sortName: "Spotify"
			});
			if (debug) console.log("Spotify source registered (go-librespot).");
		}
	}

});

module.exports = {
	version: version,
	// Quelle ist verfügbar, solange go-librespot läuft (Dienst-Autostart).
	isEnabled: function(callback) { if (callback) callback(true); }
};
