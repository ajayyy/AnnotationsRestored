const annotationParser = new AnnotationParser();
let renderer;

const postMessageOrigin = "https://www.youtube.com";

function setupExternalScript() {
	// must be done this way due to the "x-ray" mode the content scripts are run in
	// removing all non-standard functions from the player, such as getCurrentTime :/
	const code = `
		const player = document.getElementById("movie_player");
		const progressBar = player.getElementsByClassName("ytp-progress-bar")[0];
		let rendererUpdateIntervalId;
		let rendererUpdateInterval = 1000;

		let progressMoveLastCalled = 0;

		/*
		possible 'state' values
	    	-1 (unstarted)
	    	0 (ended)
	    	1 (playing)
	    	2 (paused)
	    	3 (buffering)
	    	5 (video cued).
		*/
		player.addEventListener("onStateChange", state => {
			if (state === 1) {
				__ar__startRenderer(rendererUpdateInterval);
			} 
			else if (state === 2) {
				__ar__stopRenderer();
			}
		});

		progressBar.addEventListener("mousedown", e => {
			progressBar.addEventListener("mousemove", progressMouseMoveHandler);
			progressBar.addEventListener("mouseup", progressMouseUpHandler);
		});

		function progressMouseMoveHandler() {
			// only update every 250ms for performance
			const throttled = (performance.now() - progressMoveLastCalled) < 250;
			if (!throttled) {
				__ar__updateAnnotations();
				progressMoveLastCalled = performance.now();
			}
		}
		function progressMouseUpHandler() {
			__ar__updateAnnotations();
			progressBar.removeEventListener("mouseup", progressMouseUpHandler);
			progressBar.removeEventListener("mousemove", progressMouseMoveHandler);
		}

		window.addEventListener("message", e => {
			const data = e.data;
			const type = data.type;
			if (type === "__annotations_restored_renderer_start") {
				rendererUpdateInterval = data.updateInterval;
				__ar__startRenderer(data.updateInterval);
			}
			else if (type === "__annotations_restored_renderer_stop") {
				__ar__stopRenderer();
			}
			else if (type === "__annotations_restored_renderer_seek_to") {
				__ar__seekTo(data.seconds);
			}
			else if (type === "__annotations_restored_renderer_urlclick") {
				window.location.href = data.url;
			}
		});

		function __ar__startRenderer(updateInterval) {
			if (!rendererUpdateIntervalId) {
				__ar__updateAnnotations();
				rendererUpdateIntervalId = setInterval(() => {
					__ar__updateAnnotations();
				}, updateInterval);
			}
		}
		function __ar__stopRenderer() {
			if (rendererUpdateIntervalId) {
				__ar__updateAnnotations();
				clearInterval(rendererUpdateIntervalId);
				rendererUpdateIntervalId = null;
			}
		}

		function __ar__updateAnnotations() {
			const videoTime = player.getCurrentTime();
			const updateEvent = new CustomEvent("__annotations_restored_renderer_update", {
				detail: {videoTime}
			});
			window.dispatchEvent(updateEvent);
		}

		function __ar__seekTo(seconds) {
			player.seekTo(seconds);
			const videoTime = player.getCurrentTime();
			__ar__updateAnnotations();
		}
		function __ar__updateAnnotationSizes() {
			const updateSizeEvent = new CustomEvent("__annotations_restored_renderer_update_sizes");
			window.dispatchEvent(updateSizeEvent);
		}

		window.addEventListener("resize", () => {
			__ar__updateAnnotationSizes();
		});
	`;

	const script = document.createElement("script");
	script.setAttribute("type", "text/javascript");
	script.textContent = code;
	document.body.append(script);
}

setupExternalScript();

function getAnnotationsFromDescription(description) {
	return new Promise((resolve, reject) => {
		const startFlagText = "[ar_start]";
		const startFlag = description.indexOf(startFlagText);
		const endFlag = description.indexOf("[ar_end]");

		if (startFlag === -1 || endFlag === -1) {
			reject("Couldn\'t find either a start or end flag");
			return;
		}

		try {
			const serializedAnnotations = description.substring(startFlag + startFlagText.length, endFlag);
			const annotations = annotationParser.deserializeAnnotationList(serializedAnnotations);

			resolve(annotations);
		} 
		catch (e) {
			reject(`Possibly malformed annotation data: ${e}`);
		}
	});
}
// get from github gists
function getAnnotationsGistFromDescription(description) {
	return new Promise((resolve, reject) => {
		// Gist annotations
		const startGistFlagText = "[ar_gist_start]";
		const startGistFlag = description.indexOf(startGistFlagText);
		const endGistFlag = description.indexOf("[ar_gist_end]");

		if (startGistFlag === -1 || endGistFlag === -1) {
			reject("Couldn\'t find either a start or end flag");
			return;
		}

		try {
			const gistUrlPrefix = "https://gist.githubusercontent.com/";
			const gistUrlSuffix = "/raw";

			const gistUrl = description.substring(startGistFlag + startGistFlagText.length, endGistFlag);
			const endpoint = `${gistUrlPrefix}${gistUrl}${gistUrlSuffix}`;

			fetch(endpoint)
			.then(response => response.text())
			.then(text => {
				const annotations = annotationParser.deserializeAnnotationList(text);
				resolve(annotations);
			})
			.catch(e => {
				reject(`Possibly malformed annotation data: ${e}`);
			});
		} 
		catch (e) {
			reject(`Possibly malformed annotation data: ${e}`);
		}
	});
}
// get from pastebin
function getAnnotationsPastebinFromDescription(description) {
	return new Promise((resolve, reject) => {
		// Gist annotations
		const startPasteFlagText = "[ar_pastebin_start]";
		const startPasteFlag = description.indexOf(startPasteFlagText);
		const endPasteFlag = description.indexOf("[ar_pastebin_end]");

		if (startPasteFlag === -1 || endPasteFlag === -1) {
			reject("Couldn\'t find either a start or end flag");
			return;
		}

		try {
			const pasteUrlPrefix = "https://pastebin.com/raw/";

			const startPasteFlagText = "[ar_pastebin_start]";
			const pasteUrl = description.substring(startPasteFlag + startPasteFlagText.length, endPasteFlag);
			const endpoint = `${pasteUrlPrefix}${pasteUrl}`;

			fetch(endpoint)
			.then(response => response.text())
			.then(text => {
				const annotations = annotationParser.deserializeAnnotationList(text);
				resolve(annotations);
			})
			.catch(e => {
				reject(`Possibly malformed annotation data: ${e}`);
			});
		} 
		catch (e) {
			reject(`Possibly malformed annotation data: ${e}`);
		}
	});
}

function getDescription(retries = 6, retryInterval = 500) {
	return new Promise((resolve, reject) => {
		let intervalCount = 0;
		const interval = setInterval(() => {
			if (intervalCount === retries) {
				reject();
				clearInterval(interval);
				return;
			}
			const descriptionContainer = document.getElementById("description");
			if (!descriptionContainer)
				return false;
			const formattedString = descriptionContainer.getElementsByTagName("yt-formatted-string")[0];
			if (!formattedString)
				return false;
			const description = formattedString.textContent;

			if (description) {
				resolve(description);
				clearInterval(interval);
			} 
			else {
				reject("No description text");
				clearInterval(interval);
			}
			intervalCount++;
		}, retryInterval);
	});
}

function getFirstValidDescriptionAnnotations() {
	return new Promise((resolve, reject) => {
		getDescription().then(async description => {
			const embedded = await getAnnotationsFromDescription(description).catch(e => {/* discard the error and check the next source */});
			if (embedded) { resolve({annotations: embedded, type: "embedded"}); return; }

			const gist = await getAnnotationsGistFromDescription(description).catch(e => {/* discard the error and check the next source */});
			if (gist) { resolve({annotations: gist, type: "gist"}); return; }

			const pastebin = await getAnnotationsPastebinFromDescription(description).catch(e => {/* discard the error and check the next source */});
			if (pastebin) { resolve({annotations: pastebin, type: "pastebin"}); return; }

			reject(`Couldn\'t find embedded, gist, or pastebin annotations`);
		}).catch(e => {
			reject(`Couldn\'t find description: ${e}`);
		});
	});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	console.log(request);
	if (request.type === "check_description_for_annotations") {
		getFirstValidDescriptionAnnotations().then(data => {
			startNewAnnotationRenderer(data.annotations);
			console.info(`Found ${data.type} annotation data in description`);
			sendResponse({
				foundAnnotations: true
			});
		}).catch(e => {
			console.info(e);
			sendResponse({
				foundAnnotations: false
			});
		});
		// return true so chrome knows we're responding asynchronously
		return true;
	} 
	else if (request.type === "annotations_received") {
		const annotationData = request.xml;
		if (annotationData) {
			console.info("Received annotation data from server");
			const annotationDom = annotationParser.xmlToDom(annotationData);
			const annotationElements = annotationDom.getElementsByTagName("annotation");

			const annotations = annotationParser.parseYoutubeAnnotationList(annotationElements);
			startNewAnnotationRenderer(annotations);
		}
	} 
	else if (request.type === "annotations_unavailable") {
		console.info("Annotation data for this video is unavailable");
	} 
	else if (request.type === "remove_renderer_annotations") {
		if (renderer) {
			np_stopRenderer();
			renderer.removeAnnotationElements();
		}
	}
	// popup annotation loading
	else if (request.type === "popup_load_youtube" && request.data) {
		console.info("loading youtube data");
		const annotationDom = annotationParser.xmlToDom(request.data);
		const annotationElements = annotationDom.getElementsByTagName("annotation");
		const annotations = annotationParser.parseYoutubeAnnotationList(annotationElements);
		if (!renderer) {
			startNewAnnotationRenderer(annotations);
		} 
		else {
			changeAnnotationData(annotations);
		}
	} 
	else if (request.type === "popup_load_converted" && request.data) {
		console.info("loading converted data");
		const annotations = annotationParser.deserializeAnnotationList(request.data);
		if (!renderer) {
			startNewAnnotationRenderer(annotations);
		} 
		else {
			changeAnnotationData(annotations);
		}
	}
});

function startNewAnnotationRenderer(annotations) {
	const videoContainer = document.getElementById("movie_player");
	renderer = new AnnotationRenderer(annotations, videoContainer);
	np_startRenderer();
}

window.addEventListener("__annotations_restored_renderer_update", e => {
	if (renderer && !isNaN(e.detail.videoTime)) {
		renderer.update(e.detail.videoTime);
	}
});
window.addEventListener("__ar_seek_to", e => {
	if (renderer && !isNaN(e.detail.seconds)) {
		np_seekTo(e.detail.seconds);
	}
});
window.addEventListener("__annotations_restored_renderer_update_sizes", () => {
	if (renderer) {
		renderer.updateAllAnnotationSizes()
	}
});

function changeAnnotationData(annotations) {
	np_stopRenderer();
	renderer.removeAnnotationElements();
	renderer.annotations = annotations;
	renderer.createAnnotationElements();
	renderer.updateAllAnnotationSizes();
	renderer.update();
	np_startRenderer();
}

function np_startRenderer() {
	window.postMessage({type: "__annotations_restored_renderer_start", updateInterval: 1000}, postMessageOrigin);
}
function np_stopRenderer() {
	window.postMessage({type: "__annotations_restored_renderer_stop"}, postMessageOrigin);
}
function np_seekTo(seconds) {
	window.postMessage({type: "__annotations_restored_renderer_seek_to", seconds}, postMessageOrigin);
}