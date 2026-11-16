// Settings: the server to save to and the token it gave you, both kept in
// storage.local (keys `api` and `token`), where only the extension reads them.
const form = document.getElementById('form');
const serverInput = document.getElementById('server');
const tokenInput = document.getElementById('token');
const status = document.getElementById('status');

const show = (text, kind) => {
	status.textContent = text;
	status.className = kind ?? '';
};

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// The server's base address without a trailing slash, or null. https only, so
// the token never crosses the network in the clear; http is fine on this machine.
const serverFrom = (value) => {
	const text = value.trim();
	if (!text) return null;
	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
		const local = LOCAL_HOSTS.includes(url.hostname);
		if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
		return url.origin + url.pathname.replace(/\/+$/, '');
	} catch {
		return null;
	}
};

// Asks the server about the token, so a typo shows up here, not on the first save.
const check = async (api, token) => {
	if (!api) return show('No server yet.');
	if (!token) return show('No token yet.');
	const host = new URL(api).host;
	show('Checking…');
	try {
		const response = await fetch(`${api}/ext/ping`, {
			headers: { Authorization: `Bearer ${token}` }
		});
		if (response.ok) show('Connected. Right-click an image or a video to save it.', 'good');
		else if (response.status === 401 || response.status === 403)
			show(`${host} didn't accept that token.`, 'bad');
		else show(`${host} answered ${response.status}. Is it a Save to taste server?`, 'bad');
	} catch {
		show(`Can't reach ${host} right now.`, 'bad');
	}
};

browser.storage.local.get(['api', 'token']).then(({ api, token }) => {
	if (api) serverInput.value = api;
	if (token) tokenInput.value = token;
	check(api, token);
});

form.addEventListener('submit', async (event) => {
	event.preventDefault();
	const api = serverFrom(serverInput.value);
	if (serverInput.value.trim() && !api) {
		show('The server needs an https:// address (http:// works for localhost).', 'bad');
		return;
	}
	const token = tokenInput.value.trim();
	if (api) serverInput.value = api;
	await browser.storage.local.set({ api: api ?? '', token });
	check(api, token);
});
