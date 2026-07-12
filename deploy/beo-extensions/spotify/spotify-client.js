var spotify = (function() {

var spotifyEnabled = false;

$(document).on("spotify", function(event, data) {
	if (data.header == "spotifySettings") {
		if (data.content.enabled != undefined) {
			spotifyEnabled = data.content.enabled;
			if (spotifyEnabled) {
				$("#spotify-enabled-toggle").addClass("on");
			} else {
				$("#spotify-enabled-toggle").removeClass("on");
			}
		}
	}
});

function toggleEnabled(enabled) {
	if (enabled == undefined) {
		enabled = (spotifyEnabled) ? false : true;
	}
	// Optimistische UI-Rückmeldung; der Server bestätigt anschließend den echten Dienststatus.
	if (enabled) { $("#spotify-enabled-toggle").addClass("on"); } else { $("#spotify-enabled-toggle").removeClass("on"); }
	beo.send({target: "spotify", header: "spotifyEnabled", content: {enabled: enabled}});
}

return {
	toggleEnabled: toggleEnabled
}

})();
