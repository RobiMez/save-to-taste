// Save to taste, the part that runs in pages: it remembers where the last
// right-click was and draws the save indicator there, following the pointer
// while a save runs. Built with DOM calls and element.style only (no
// innerHTML, no <style>), so a strict page CSP or Trusted Types can't stop it.
// The background script drives it through globalThis.tasteToast.

(() => {
	if (globalThis.tasteToast) return;

	const ID = 'save-to-taste-indicator';
	const SVG = 'http://www.w3.org/2000/svg';
	const GAP = 14;
	let cursor = null;

	addEventListener(
		'contextmenu',
		(event) => {
			cursor = { x: event.clientX, y: event.clientY };
		},
		{ capture: true, passive: true }
	);

	const svg = (children) => {
		const icon = document.createElementNS(SVG, 'svg');
		icon.setAttribute('viewBox', '0 0 16 16');
		icon.setAttribute('width', '14');
		icon.setAttribute('height', '14');
		icon.setAttribute('aria-hidden', 'true');
		for (const [tag, attributes] of children) {
			const node = document.createElementNS(SVG, tag);
			for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
			icon.append(node);
			if (tag === 'circle' && attributes['data-spin']) {
				// SMIL rather than CSS, so no stylesheet is needed.
				const spin = document.createElementNS(SVG, 'animateTransform');
				spin.setAttribute('attributeName', 'transform');
				spin.setAttribute('type', 'rotate');
				spin.setAttribute('from', '0 8 8');
				spin.setAttribute('to', '360 8 8');
				spin.setAttribute('dur', '0.9s');
				spin.setAttribute('repeatCount', 'indefinite');
				node.append(spin);
			}
		}
		return icon;
	};

	const icons = {
		busy: () =>
			svg([
				[
					'circle',
					{
						cx: '8',
						cy: '8',
						r: '6',
						fill: 'none',
						stroke: 'rgb(255 255 255 / 0.25)',
						'stroke-width': '2'
					}
				],
				[
					'circle',
					{
						cx: '8',
						cy: '8',
						r: '6',
						fill: 'none',
						stroke: 'white',
						'stroke-width': '2',
						'stroke-linecap': 'round',
						'stroke-dasharray': '10 28',
						'data-spin': '1'
					}
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

	// Beside the point, flipped to the other side near the viewport's edges.
	const place = (box, x, y) => {
		const { width, height } = box.getBoundingClientRect();
		const left = x + GAP + width > innerWidth - 8 ? x - GAP - width : x + GAP;
		const top = y + GAP + height > innerHeight - 8 ? y - GAP - height : y + GAP;
		box.style.left = `${Math.max(8, left)}px`;
		box.style.top = `${Math.max(8, top)}px`;
	};

	globalThis.tasteToast = (text, state) => {
		let box = document.getElementById(ID);
		// A finished indicator (fading out) makes way for a new save at the new cursor.
		if (box && box._state !== 'busy') {
			clearTimeout(box._hide);
			clearTimeout(box._remove);
			box.remove();
			box = null;
		}
		if (!box) {
			box = document.createElement('div');
			box.id = ID;
			box.setAttribute('role', 'status');
			box.setAttribute('aria-live', 'polite');
			Object.assign(box.style, {
				position: 'fixed',
				zIndex: '2147483647',
				display: 'flex',
				alignItems: 'center',
				gap: '7px',
				maxWidth: '280px',
				padding: '6px 10px',
				borderRadius: '8px',
				background: 'rgb(24 24 24 / 0.94)',
				color: 'white',
				font: '12px/1.35 system-ui, -apple-system, sans-serif',
				pointerEvents: 'none',
				opacity: '1',
				transition: 'opacity 200ms ease-out'
			});
			box.append(document.createElement('span'), document.createElement('span'));
			document.documentElement.append(box);
			const start = cursor ?? { x: innerWidth - 300, y: innerHeight - 60 };
			box._point = start;
			box._follow = (event) => {
				box._point = { x: event.clientX, y: event.clientY };
				place(box, event.clientX, event.clientY);
			};
		}

		box._state = state;
		const [iconSlot, label] = box.children;
		iconSlot.replaceChildren(icons[state]?.() ?? icons.busy());
		iconSlot.style.display = 'flex';
		label.textContent = text;
		label.style.color = state === 'error' ? 'rgb(255 190 180)' : 'white';
		place(box, box._point.x, box._point.y);

		clearTimeout(box._hide);
		if (state === 'busy') {
			addEventListener('pointermove', box._follow, { capture: true, passive: true });
		} else {
			removeEventListener('pointermove', box._follow, { capture: true });
			box._hide = setTimeout(
				() => {
					box.style.opacity = '0';
					box._remove = setTimeout(() => box.remove(), 220);
				},
				state === 'error' ? 5000 : 1600
			);
		}
	};
})();
