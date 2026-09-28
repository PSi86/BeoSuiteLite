var spotify = (function() {

var spotifyEnabled = false;
var pendingTimeout = null;

function setPending(pending) {
	clearTimeout(pendingTimeout);
	if (pending) {
		$("#spotify-enabled-toggle").addClass("disabled");
		// No answer (e.g. server restart): release the switch again, still showing
		// the last confirmed state.
		pendingTimeout = setTimeout(function() { setPending(false); }, 15000);
	} else {
		$("#spotify-enabled-toggle").removeClass("disabled");
	}
}

$(document).on("spotify", function(event, data) {
	if (data.header == "spotifySettings") {
		if (data.content.enabled != undefined) {
			spotifyEnabled = data.content.enabled;
			if (spotifyEnabled) {
				$("#spotify-enabled-toggle").addClass("on");
			} else {
				$("#spotify-enabled-toggle").removeClass("on");
			}
			setPending(false);
		}
	}
});

function toggleEnabled(enabled) {
	if ($("#spotify-enabled-toggle").hasClass("disabled")) return; // change in progress
	if (enabled == undefined) {
		enabled = (spotifyEnabled) ? false : true;
	}
	// The switch keeps showing the confirmed state; it flips only when the server
	// reports the actual service state back (spotifySettings).
	setPending(true);
	beo.send({target: "spotify", header: "spotifyEnabled", content: {enabled: enabled}});
}

return {
	toggleEnabled: toggleEnabled
}

})();
