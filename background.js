// Save to taste: right-click an image or a video, and it's added on top of
// this week on your taste server, credited to the page it came from.
//
// Everything talks to the server from here, never from the page: the token
// stays out of page scripts, and a page's CSP can't block the upload. Videos
// with a real file are fetched like images; streamed ones (a blob: source,
// as on Pinterest) are recorded from the playing element in the page and
// handed back as bytes. The server's side is in the README.

// A failure on the server's side (or on the way to it). Retrying with a
// smaller copy of the image won't help with these.
class ServerError extends Error {}

// The server and token from the settings page (options.js).
const settings = async () => {
	const { api, token } = await browser.storage.local.get(['api', 'token']);
	if (!api || !token) {
		throw new ServerError('Set your server and token in the Save to taste settings first.');
	}
	return { api, token };
};

const unreachable = (api) => new ServerError(`Can't reach ${new URL(api).host}.`);

// The Monday of the viewer's local week, as YYYY-MM-DD (the server files entries by week).
const thisMonday = () => {
	const now = new Date();
	const day = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12));
	day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
	return day.toISOString().slice(0, 10);
};

const isWebLink = (value) => {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:';
	} catch {
		return false;
	}
};

// The item's own page when the image sits inside a link to one (a pin in a
// board, an element in a Cosmos grid), otherwise the page you're on.
const sourceOf = (info) => {
	const page = info.frameUrl && isWebLink(info.frameUrl) ? info.frameUrl : info.pageUrl;
	if (info.linkUrl && isWebLink(info.linkUrl) && isWebLink(page)) {
		const link = new URL(info.linkUrl);
		const here = new URL(page);
		if (link.hostname === here.hostname && link.pathname !== here.pathname) return link.href;
	}
	return isWebLink(page) ? page : '';
};

// Bigger versions to try before the one on screen.
const imageCandidates = (src) => {
	const url = new URL(src);
	if (url.hostname === 'i.pinimg.com' && /^\/\d+x\//.test(url.pathname)) {
		const original = new URL(url);
		original.pathname = url.pathname.replace(/^\/\d+x\//, '/originals/');
		return [original.href, src];
	}
	if (url.hostname === 'cdn.cosmos.so' && url.search) {
		// Cosmos sizes its CDN images with query parameters; without them it's the original.
		return [url.origin + url.pathname, src];
	}
	return [src];
};

const fetchBytes = async (url) => {
	const response = await fetch(url, { credentials: 'omit' });
	if (!response.ok) throw new Error(`The site answered ${response.status}.`);
	return { bytes: await response.arrayBuffer(), type: response.headers.get('content-type') ?? '' };
};

const STALL_MS = 60_000;

// XHR rather than fetch, because only XHR reports how far an upload has got,
// and a minute of recorded video is tens of megabytes on a slow uplink. An
// upload that stops moving for a minute is given up on.
const post = (url, headers, body, onProgress) =>
	new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		let stall;
		const watch = () => {
			clearTimeout(stall);
			stall = setTimeout(() => request.abort(), STALL_MS);
		};
		request.open('POST', url);
		for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
		request.upload.onprogress = (event) => {
			watch();
			if (event.lengthComputable) onProgress?.(event.loaded, event.total);
		};
		request.onload = () => {
			clearTimeout(stall);
			let answer = {};
			try {
				answer = JSON.parse(request.responseText);
			} catch {
				// Not JSON; the status alone has to do.
			}
			resolve({
				ok: request.status >= 200 && request.status < 300,
				status: request.status,
				answer
			});
		};
		request.onerror = () => {
			clearTimeout(stall);
			reject(new Error('network'));
		};
		request.onabort = () => reject(new ServerError('The upload stopped moving. Try again.'));
		watch();
		request.send(body);
	});

const upload = async (bytes, type, { source, width, height }, onProgress) => {
	const { api, token } = await settings();
	const params = new URLSearchParams({ week: thisMonday() });
	if (source) params.set('source', source);
	if (width && height) {
		params.set('width', String(width));
		params.set('height', String(height));
	}
	let response;
	try {
		response = await post(
			`${api}/ext/entries?${params}`,
			{ Authorization: `Bearer ${token}`, 'Content-Type': type || 'application/octet-stream' },
			bytes,
			onProgress
		);
	} catch (error) {
		throw error instanceof ServerError ? error : unreachable(api);
	}
	const { answer } = response;
	if (!response.ok) {
		throw new ServerError(answer.error ?? `The server answered ${response.status}.`);
	}
	return answer;
};

// ---- In-page helper. Injected with scripting.executeScript, so it's
// self-contained; the indicator itself is page.js (globalThis.tasteToast). ---

// Finds the video that was right-clicked. A real file comes back as its URL;
// a streamed one is recorded as it plays (from the start, up to a minute) and
// comes back as webm bytes.
async function grabVideo(targetElementId) {
	const say = (text, state) => globalThis.tasteToast?.(text, state);

	const target = browser.menus.getTargetElement(targetElementId);
	// The right-clicked element, or (under an overlay) the video page.js found.
	const underCursor = globalThis.tasteMedia?.();
	const video =
		target instanceof HTMLVideoElement
			? target
			: (target?.closest?.('video') ??
				target?.querySelector?.('video') ??
				(underCursor instanceof HTMLVideoElement ? underCursor : null));
	if (!video) return { error: 'No video where you clicked.' };

	const width = video.videoWidth;
	const height = video.videoHeight;
	const src = video.currentSrc || video.src;
	if (/^https?:/.test(src) && !/\.m3u8(\?|$)/.test(src))
		return { mode: 'file', src, width, height };

	const capture = video.mozCaptureStream ? video.mozCaptureStream() : video.captureStream();
	const track = capture.getVideoTracks()[0];
	if (!track) return { error: "This video can't be recorded." };
	const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((candidate) =>
		MediaRecorder.isTypeSupported(candidate)
	);
	const recorder = new MediaRecorder(new MediaStream([track]), {
		mimeType: type,
		videoBitsPerSecond: 6_000_000
	});
	const chunks = [];
	recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
	const stopped = new Promise((resolve) => (recorder.onstop = resolve));

	const seconds = Math.min(
		Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 15,
		60
	);
	video.currentTime = 0;
	// play() can wait forever on a stream the site has stopped feeding.
	await Promise.race([
		video.play().catch(() => undefined),
		new Promise((resolve) => setTimeout(resolve, 8000))
	]);
	if (video.paused) return { error: "The video won't play from here. Start it, then save again." };
	recorder.start(1000);
	const started = performance.now();
	await new Promise((resolve) => {
		const tick = () => {
			const left = seconds - (performance.now() - started) / 1000;
			if (left <= 0) return resolve();
			say(`Recording, ${Math.ceil(left)}s`, 'busy');
			setTimeout(tick, 250);
		};
		tick();
	});
	recorder.stop();
	await stopped;
	say('Saving…', 'busy');
	const bytes = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
	return { mode: 'recorded', bytes, width, height };
}

// ---- Menu ---------------------------------------------------------------

browser.runtime.onInstalled.addListener(() => {
	browser.menus.create({ id: 'save-image', title: 'Save image to taste', contexts: ['image'] });
	browser.menus.create({ id: 'save-video', title: 'Save video to taste', contexts: ['video'] });
	// Shown only when page.js finds media under an overlay (see menus.onShown).
	browser.menus.create({
		id: 'save-under-cursor',
		title: 'Save image to taste',
		contexts: ['page', 'link', 'frame'],
		visible: false
	});
	browser.storage.local.get(['api', 'token']).then(({ api, token }) => {
		if (!api || !token) browser.runtime.openOptionsPage();
	});
});

browser.action.onClicked.addListener(() => browser.runtime.openOptionsPage());

// Shows the indicator by the cursor (page.js). page.js is declared for every
// page, but tabs opened before install don't have it yet, so it's injected on
// demand; pages extensions can't touch (about:, the add-on store) get none.
const toast = async (tab, frameId, text, state, options = {}) => {
	const target = { tabId: tab.id, frameIds: [frameId ?? 0] };
	const show = (t, s, o) => {
		if (!globalThis.tasteToast) return false;
		globalThis.tasteToast(t, s, o);
		return true;
	};
	try {
		const [shown] = await browser.scripting.executeScript({
			target,
			func: show,
			args: [text, state, options]
		});
		if (shown?.result) return;
		await browser.scripting.executeScript({ target, files: ['page.js'] });
		await browser.scripting.executeScript({ target, func: show, args: [text, state, options] });
	} catch {
		// No indicator here; the save itself still goes ahead.
	}
};

const saveImage = async (info, onProgress) => {
	if (!isWebLink(info.srcUrl) && !info.srcUrl.startsWith('data:')) {
		throw new Error("This image can't be saved from here. Download it and add it on your server.");
	}
	let lastError;
	for (const candidate of info.srcUrl.startsWith('data:')
		? [info.srcUrl]
		: imageCandidates(info.srcUrl)) {
		try {
			const { bytes, type } = await fetchBytes(candidate);
			return await upload(bytes, type, { source: sourceOf(info) }, onProgress);
		} catch (error) {
			lastError = error;
			if (error instanceof ServerError) throw error;
		}
	}
	throw lastError;
};

const saveVideo = async (info, tab, onProgress) => {
	const [result] = await browser.scripting.executeScript({
		target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
		func: grabVideo,
		args: [info.targetElementId]
	});
	const video = result?.result;
	if (!video) throw new Error("Couldn't reach the video on this page.");
	if (video.error) throw new Error(video.error);
	const source = sourceOf(info);
	if (video.mode === 'file') {
		const { bytes, type } = await fetchBytes(video.src);
		return upload(bytes, type, { source, width: video.width, height: video.height }, onProgress);
	}
	return upload(
		video.bytes,
		'video/webm',
		{ source, width: video.width, height: video.height },
		onProgress
	);
};

// When the right-click didn't land on an image or video itself, ask the page
// whether one sits under the cursor and show the item if so. Firefox lets the
// open menu be refreshed after this async check; the instance number drops a
// stale answer from a menu that has already closed.
let menuInstance = 0;
browser.menus.onShown.addListener(async (info, tab) => {
	if (info.contexts.includes('image') || info.contexts.includes('video') || !tab?.id) return;
	const instance = ++menuInstance;
	let kind = null;
	try {
		const [result] = await browser.scripting.executeScript({
			target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
			func: () => globalThis.tasteMediaKind?.() ?? null
		});
		kind = result?.result ?? null;
	} catch {
		// Not a page we can read.
	}
	if (instance !== menuInstance || !kind) return;
	await browser.menus.update('save-under-cursor', {
		visible: true,
		title: kind === 'video' ? 'Save video to taste' : 'Save image to taste'
	});
	browser.menus.refresh();
});

browser.menus.onHidden.addListener(() => {
	menuInstance++;
	browser.menus.update('save-under-cursor', { visible: false });
});

// The image or video page.js found under the cursor.
const mediaUnderCursor = async (info, tab) => {
	const [result] = await browser.scripting.executeScript({
		target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
		func: () => {
			const media = globalThis.tasteMedia?.();
			if (!media) return null;
			return { kind: globalThis.tasteMediaKind(), src: media.currentSrc || media.src };
		}
	});
	return result?.result ?? null;
};

// The note typed into the save card. The page sends it here because the
// token lives only in this script.
browser.runtime.onMessage.addListener(async (message) => {
	if (message?.type !== 'taste-note') return undefined;
	let api, token;
	try {
		({ api, token } = await settings());
	} catch (error) {
		return { error: error.message };
	}
	try {
		const response = await fetch(`${api}/ext/entries/${Number(message.entryId)}`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ note: String(message.note ?? '') })
		});
		const body = await response.json().catch(() => ({}));
		return response.ok
			? { ok: true }
			: { error: body.error ?? `The server answered ${response.status}.` };
	} catch {
		return { error: unreachable(api).message };
	}
});

// Firefox suspends an idle background page after 30 seconds, and a save that's
// still running only buys it one more 30. Recording a minute of video and
// uploading it takes longer than that, so the save died halfway and left the
// card on "Saving…". Any call into Firefox counts as activity, so one runs
// every 20 seconds while a save is going.
const keepAwake = () => {
	const timer = setInterval(() => browser.runtime.getPlatformInfo(), 20_000);
	return () => clearInterval(timer);
};

// Files under this size upload too fast for a percentage to mean anything.
const SHOW_PROGRESS_FROM = 2_000_000;

browser.menus.onClicked.addListener(async (info, tab) => {
	if (!tab?.id) return;
	// One card update at a time, in order, so a late progress update can't
	// land after "Saved" and reopen the card.
	let updates = Promise.resolve();
	const say = (text, state, options) =>
		(updates = updates.then(() => toast(tab, info.frameId, text, state, options)));
	try {
		await settings();
	} catch (error) {
		await say(error.message, 'error');
		browser.runtime.openOptionsPage();
		return;
	}
	const release = keepAwake();
	let shown = -1;
	const onProgress = (loaded, total) => {
		if (total < SHOW_PROGRESS_FROM) return;
		const percent = Math.floor((loaded / total) * 100);
		if (percent < shown + 5) return;
		shown = percent;
		say(`Uploading, ${percent}%`, 'busy');
	};
	// The card opens with the note box, so the why can be typed while it saves.
	await say('Saving…', 'busy', { note: true });
	try {
		let saved;
		if (info.menuItemId === 'save-under-cursor') {
			const found = await mediaUnderCursor(info, tab);
			if (!found) throw new Error('Nothing to save under the cursor.');
			saved =
				found.kind === 'video'
					? await saveVideo(info, tab, onProgress)
					: await saveImage({ ...info, srcUrl: found.src }, onProgress);
		} else {
			saved =
				info.menuItemId === 'save-video'
					? await saveVideo(info, tab, onProgress)
					: await saveImage(info, onProgress);
		}
		const { week, entry } = saved;
		const day = new Date(`${week}T12:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
		await say(`Saved to taste, week of ${day}`, 'done', { entryId: entry.id });
	} catch (error) {
		await say(error.message || 'Saving failed.', 'error');
	} finally {
		release();
	}
});
