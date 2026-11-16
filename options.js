const apiBase = async () =>
	(await browser.storage.local.get('api')).api ?? 'https://taste.robi.work';
const form = document.getElementById('form');
const input = document.getElementById('token');
const status = document.getElementById('status');

const show = (text, kind) => {
	status.textContent = text;
	status.className = kind ?? '';
};

// Checks the token against taste-api, so a typo shows up here, not on the first save.
const check = async (token) => {
	if (!token) return show('No token yet.');
	show('Checking…');
	try {
		const response = await fetch(`${await apiBase()}/ext/ping`, {
			headers: { Authorization: `Bearer ${token}` }
		});
		if (response.ok) show('Connected. Right-click an image or a video to save it.', 'good');
		else show('That token was not accepted. Make a new one in the admin.', 'bad');
	} catch {
		show("Can't reach taste.robi.work right now.", 'bad');
	}
};

browser.storage.local.get('token').then(({ token }) => {
	if (token) input.value = token;
	check(token);
});

form.addEventListener('submit', async (event) => {
	event.preventDefault();
	const token = input.value.trim();
	await browser.storage.local.set({ token });
	check(token);
});
