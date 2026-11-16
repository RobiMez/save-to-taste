// Save to taste: right-click an image or a video, and it's added on top of
// this week on robi.work/taste, credited to the page it came from.
//
// Everything talks to taste-api from here, never from the page: the token
// stays out of page scripts, and a page's CSP can't block the upload. Videos
// with a real file are fetched like images; streamed ones (a blob: source,
// as on Pinterest) are recorded from the playing element in the page and
// handed back as bytes.

// Overridable for local testing (storage key `api`); nothing in the UI sets it.
const apiBase = async () =>
	(await browser.storage.local.get('api')).api ?? 'https://taste.robi.work';

// The Monday of the viewer's local week, as YYYY-MM-DD (what taste-api calls a week).
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

const upload = async (bytes, type, { source, width, height }) => {
	const { token } = await browser.storage.local.get('token');
	if (!token) throw new Error('Add your token in the Save to taste settings first.');
	const params = new URLSearchParams({ week: thisMonday() });
	if (source) params.set('source', source);
	if (width && height) {
		params.set('width', String(width));
		params.set('height', String(height));
	}
	let response;
	try {
		response = await fetch(`${await apiBase()}/ext/entries?${params}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': type || 'application/octet-stream'
			},
			body: bytes
		});
	} catch {
		throw new Error("Can't reach taste.robi.work.");
	}
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error ?? `taste answered ${response.status}.`);
	return body;
};

// ---- In-page helper. Injected with scripting.executeScript, so it's
// self-contained; the indicator itself is page.js (globalThis.tasteToast). ---

// Finds the video that was right-clicked. A real file comes back as its URL;
// a streamed one is recorded as it plays (from the start, up to a minute) and
// comes back as webm bytes.
async function grabVideo(targetElementId) {
	const say = (text, state) => globalThis.tasteToast?.(text, state);

	const target = browser.menus.getTargetElement(targetElementId);
	const video =
		target instanceof HTMLVideoElement
			? target
			: (target?.closest?.('video') ?? target?.querySelector?.('video'));
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
	await video.play().catch(() => undefined);
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
	browser.storage.local.get('token').then(({ token }) => {
		if (!token) browser.runtime.openOptionsPage();
	});
});

browser.action.onClicked.addListener(() => browser.runtime.openOptionsPage());

// Shows the indicator by the cursor (page.js). page.js is declared for every
// page, but tabs opened before install don't have it yet, so it's injected on
// demand; pages extensions can't touch (about:, the add-on store) get none.
const toast = async (tab, frameId, text, state) => {
	const target = { tabId: tab.id, frameIds: [frameId ?? 0] };
	const show = (t, s) => {
		if (!globalThis.tasteToast) return false;
		globalThis.tasteToast(t, s);
		return true;
	};
	try {
		const [shown] = await browser.scripting.executeScript({
			target,
			func: show,
			args: [text, state]
		});
		if (shown?.result) return;
		await browser.scripting.executeScript({ target, files: ['page.js'] });
		await browser.scripting.executeScript({ target, func: show, args: [text, state] });
	} catch {
		// No indicator here; the save itself still goes ahead.
	}
};

const saveImage = async (info) => {
	if (!isWebLink(info.srcUrl) && !info.srcUrl.startsWith('data:')) {
		throw new Error("This image can't be saved from here. Save it and drop it into the admin.");
	}
	let lastError;
	for (const candidate of info.srcUrl.startsWith('data:')
		? [info.srcUrl]
		: imageCandidates(info.srcUrl)) {
		try {
			const { bytes, type } = await fetchBytes(candidate);
			return await upload(bytes, type, { source: sourceOf(info) });
		} catch (error) {
			lastError = error;
			// A rejection from taste itself won't get better with a smaller copy.
			if (error.message?.startsWith('taste') || error.message?.includes('token')) throw error;
		}
	}
	throw lastError;
};

const saveVideo = async (info, tab) => {
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
		return upload(bytes, type, { source, width: video.width, height: video.height });
	}
	return upload(video.bytes, 'video/webm', { source, width: video.width, height: video.height });
};

browser.menus.onClicked.addListener(async (info, tab) => {
	if (!tab?.id) return;
	const { token } = await browser.storage.local.get('token');
	if (!token) {
		await toast(tab, info.frameId, 'Add your token in the Save to taste settings first.', 'error');
		browser.runtime.openOptionsPage();
		return;
	}
	await toast(tab, info.frameId, 'Saving…', 'busy');
	try {
		const { week } =
			info.menuItemId === 'save-video' ? await saveVideo(info, tab) : await saveImage(info);
		const day = new Date(`${week}T12:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
		await toast(tab, info.frameId, `Saved to taste, week of ${day}`, 'done');
	} catch (error) {
		await toast(tab, info.frameId, error.message || 'Saving failed.', 'error');
	}
});
