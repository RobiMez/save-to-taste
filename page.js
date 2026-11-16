// Save to taste, the part that runs in pages. It remembers where the last
// right-click was and what picture or video sat under it (through any
// overlay), and it draws the save card there: status on top, then a box for
// why you liked it, so the note goes in from the same click.
//
// The card lives in a shadow root and is styled through element.style only
// (no <style>, no innerHTML), so page CSS can't reach it and a strict CSP or
// Trusted Types can't block it. The background script drives it through
// globalThis.tasteToast; the note goes back through runtime messaging, so
// the token never enters the page.

(() => {
	if (globalThis.tasteToast) return;

	const ID = 'save-to-taste-card';
	const SVG = 'http://www.w3.org/2000/svg';
	const GAP = 14;
	let cursor = null;

	// Sites often lay a transparent overlay over their images (Cosmos's viewer
	// does), so a right-click lands on a div and Firefox offers no image menu.
	let media = null;
	const mediaAt = (x, y) =>
		document
			.elementsFromPoint(x, y)
			.find(
				(el) =>
					(el instanceof HTMLImageElement && el.naturalWidth >= 64 && el.currentSrc) ||
					(el instanceof HTMLVideoElement && el.videoWidth > 0)
			) ?? null;

	addEventListener(
		'contextmenu',
		(event) => {
			cursor = { x: event.clientX, y: event.clientY };
			media = mediaAt(event.clientX, event.clientY);
		},
		{ capture: true, passive: true }
	);

	globalThis.tasteMedia = () => media;
	globalThis.tasteMediaKind = () =>
		media instanceof HTMLVideoElement
			? 'video'
			: media instanceof HTMLImageElement
				? 'image'
				: null;

	// ---- Icons ---------------------------------------------------------------

	const svg = (children) => {
		const icon = document.createElementNS(SVG, 'svg');
		icon.setAttribute('viewBox', '0 0 16 16');
		icon.setAttribute('width', '14');
		icon.setAttribute('height', '14');
		icon.setAttribute('aria-hidden', 'true');
		for (const [tag, attributes, spin] of children) {
			const node = document.createElementNS(SVG, tag);
			for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
			if (spin) {
				// SMIL rather than CSS, so no stylesheet is needed.
				const rotate = document.createElementNS(SVG, 'animateTransform');
				rotate.setAttribute('attributeName', 'transform');
				rotate.setAttribute('type', 'rotate');
				rotate.setAttribute('from', '0 8 8');
				rotate.setAttribute('to', '360 8 8');
				rotate.setAttribute('dur', '0.9s');
				rotate.setAttribute('repeatCount', 'indefinite');
				node.append(rotate);
			}
			icon.append(node);
		}
		return icon;
	};

	const ring = { cx: '8', cy: '8', r: '6', fill: 'none', 'stroke-width': '2' };
	const icons = {
		busy: () =>
			svg([
				['circle', { ...ring, stroke: 'rgb(255 255 255 / 0.25)' }],
				[
					'circle',
					{ ...ring, stroke: 'white', 'stroke-linecap': 'round', 'stroke-dasharray': '10 28' },
					true
				]
			]),
		done: () =>
			svg([
				[
					'path',
					{
						d: 'M3.5 8.5l3 3 6-7',
						fill: 'none',
						stroke: 'rgb(150 220 170)',
						'stroke-width': '2',
						'stroke-linecap': 'round',
						'stroke-linejoin': 'round'
					}
				]
			]),
		error: () =>
			svg([
				['circle', { cx: '8', cy: '8', r: '7', fill: 'rgb(255 170 160)' }],
				[
					'path',
					{
						d: 'M8 4.5v4.5M8 11.5v.01',
						stroke: 'rgb(24 24 24)',
						'stroke-width': '2',
						'stroke-linecap': 'round'
					}
				]
			])
	};

	// ---- The card ------------------------------------------------------------

	const FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
	let card = null;

	// Beside the point, flipped to the other side near the viewport's edges.
	const place = () => {
		const { width, height } = card.host.getBoundingClientRect();
		const { x, y } = card.point;
		const left = x + GAP + width > innerWidth - 8 ? x - GAP - width : x + GAP;
		const top = y + GAP + height > innerHeight - 8 ? y - GAP - height : y + GAP;
		card.host.style.left = `${Math.max(8, left)}px`;
		card.host.style.top = `${Math.max(8, top)}px`;
	};

	const close = () => {
		if (!card) return;
		const { host, hide } = card;
		clearTimeout(hide);
		card = null;
		host.style.opacity = '0';
		setTimeout(() => host.remove(), 200);
	};

	// Hide after a while, unless a note is being written.
	const scheduleHide = (ms) => {
		clearTimeout(card.hide);
		card.hide = setTimeout(() => {
			if (!card || card.field === card.root.activeElement || card.field?.value.trim()) return;
			close();
		}, ms);
	};

	const setHint = (text, tone = 'muted') => {
		if (!card?.hint) return;
		card.hint.textContent = text;
		card.hint.style.color =
			tone === 'error'
				? 'rgb(255 190 180)'
				: tone === 'good'
					? 'rgb(150 220 170)'
					: 'rgb(255 255 255 / 0.5)';
	};

	// Sends the note once the entry exists; until then it waits for the save.
	const sendNote = async () => {
		if (!card?.field) return;
		const note = card.field.value.trim();
		if (!note || note === card.sentNote) return;
		if (!card.entryId) {
			card.pendingNote = note;
			setHint('Saves with the visual…');
			return;
		}
		const current = card;
		const { entryId } = current;
		setHint('Saving note…');
		try {
			const result = await browser.runtime.sendMessage({ type: 'taste-note', entryId, note });
			if (result?.error) throw new Error(result.error);
			if (card !== current) return;
			current.sentNote = note;
			setHint('Note saved', 'good');
			current.field.blur();
			setTimeout(() => card === current && close(), 1200);
		} catch (error) {
			if (card === current) setHint(error.message || "The note didn't save.", 'error');
		}
	};

	const build = (withNote) => {
		const host = document.createElement('div');
		host.id = ID;
		const root = host.attachShadow({ mode: 'closed' });
		Object.assign(host.style, {
			position: 'fixed',
			zIndex: '2147483647',
			opacity: '1',
			transition: 'opacity 180ms ease-out'
		});

		const box = document.createElement('div');
		Object.assign(box.style, {
			display: 'flex',
			flexDirection: 'column',
			gap: '8px',
			width: withNote ? '272px' : 'auto',
			maxWidth: '300px',
			padding: withNote ? '9px 10px 10px' : '6px 10px',
			borderRadius: '10px',
			background: 'rgb(24 24 24 / 0.95)',
			color: 'white',
			font: `12px/1.35 ${FONT}`,
			boxShadow: '0 0 0 1px rgb(255 255 255 / 0.08)'
		});

		const status = document.createElement('div');
		status.setAttribute('role', 'status');
		status.setAttribute('aria-live', 'polite');
		Object.assign(status.style, { display: 'flex', alignItems: 'center', gap: '7px' });
		const iconSlot = document.createElement('span');
		iconSlot.style.display = 'flex';
		const label = document.createElement('span');
		status.append(iconSlot, label);
		box.append(status);

		let field = null;
		let hint = null;
		if (withNote) {
			field = document.createElement('textarea');
			field.rows = 3;
			field.placeholder = 'Why it stuck with you';
			field.setAttribute('aria-label', 'Why it stuck with you');
			Object.assign(field.style, {
				boxSizing: 'border-box',
				width: '100%',
				resize: 'none',
				margin: '0',
				padding: '7px 9px',
				border: '1px solid rgb(255 255 255 / 0.18)',
				borderRadius: '7px',
				background: 'rgb(255 255 255 / 0.07)',
				color: 'white',
				font: `13px/1.45 ${FONT}`,
				outline: 'none'
			});
			field.addEventListener('focus', () => {
				field.style.borderColor = 'rgb(255 255 255 / 0.45)';
				clearTimeout(card?.hide);
			});
			field.addEventListener('blur', () => {
				field.style.borderColor = 'rgb(255 255 255 / 0.18)';
				// Clicking away keeps what was written.
				if (field.value.trim()) sendNote();
				else if (card?.state === 'done') scheduleHide(2500);
			});
			field.addEventListener('keydown', (event) => {
				// Keep the page's own keyboard shortcuts out of the typing.
				event.stopPropagation();
				if (event.key === 'Enter' && !event.shiftKey) {
					event.preventDefault();
					sendNote();
				} else if (event.key === 'Escape') {
					event.preventDefault();
					close();
				}
			});
			for (const type of ['keyup', 'keypress', 'input']) {
				field.addEventListener(type, (event) => event.stopPropagation());
			}

			hint = document.createElement('div');
			hint.textContent = 'Enter to save · Esc to close';
			Object.assign(hint.style, { color: 'rgb(255 255 255 / 0.5)', fontSize: '11px' });
			box.append(field, hint);
		}

		root.append(box);
		document.documentElement.append(host);
		return { host, root, iconSlot, label, field, hint };
	};

	/**
	 * Shows or updates the card. `state` is busy, done or error. With
	 * `note: true` the card has the note box; `entryId` arrives with "done".
	 */
	globalThis.tasteToast = (text, state, options = {}) => {
		// A finished card makes way for a new save at the new cursor.
		if (card && card.state !== 'busy') close();
		if (!card) {
			card = {
				...build(Boolean(options.note)),
				point: cursor ?? { x: innerWidth - 320, y: innerHeight - 160 }
			};
			card.field?.focus({ preventScroll: true });
		}

		card.state = state;
		card.iconSlot.replaceChildren(icons[state]?.() ?? icons.busy());
		card.label.textContent = text;
		card.label.style.color = state === 'error' ? 'rgb(255 190 180)' : 'white';
		place();

		if (options.entryId) {
			card.entryId = options.entryId;
			if (card.pendingNote) sendNote();
		}

		if (state === 'error') {
			// Nothing was saved, so there's nothing to write a note on.
			card.field?.remove();
			card.hint?.remove();
			card.field = null;
			card.hint = null;
			place();
			scheduleHide(5000);
		} else if (state === 'done') {
			scheduleHide(card.field ? 6000 : 1600);
		}
	};
})();
