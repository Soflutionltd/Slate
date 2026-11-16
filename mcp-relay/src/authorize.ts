import { AuthorizationError, CimdFetchError, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { escapeHtml } from './crypto';
import type { Env, GrantProps } from './env';

type Lang = 'fr' | 'en';

const RETRY_ERROR_PARAM = 'slate_error';

const TEXT = {
	fr: {
		title: (name: string) => `Connecter ${name} à Slate`,
		lead: (name: string) =>
			`${name} pourra lire et modifier les PDF ouverts dans Slate sur votre ordinateur. Chaque modification reste annulable avec ⌘Z.`,
		steps: 'Dans Slate, ouvrez Réglages → Connecteurs → « Connecter une IA », puis cliquez sur « Afficher un code ».',
		codeLabel: 'Code à 6 chiffres',
		allow: 'Autoriser',
		deny: 'Refuser',
		destination: (host: string) => `L’accès sera envoyé à ${host}.`,
		loopback: 'Cet accès part vers une application de cet ordinateur. Continuez seulement si vous venez de lancer la connexion depuis elle.',
		unverified: 'Le nom de cette application n’est pas vérifié.',
		invalid: 'Code incorrect ou expiré. Affichez un nouveau code dans Slate.',
		rateLimited: 'Trop d’essais. Patientez un quart d’heure, puis affichez un nouveau code dans Slate.',
		expired: 'Cette page a expiré. Relancez la connexion depuis votre IA.',
		broken: 'Cette demande de connexion n’est pas valide.'
	},
	en: {
		title: (name: string) => `Connect ${name} to Slate`,
		lead: (name: string) =>
			`${name} will be able to read and edit the PDFs open in Slate on your computer. Every change can be undone with ⌘Z.`,
		steps: 'In Slate, open Settings → Connectors → “Connect an AI”, then click “Show a code”.',
		codeLabel: '6-digit code',
		allow: 'Allow',
		deny: 'Deny',
		destination: (host: string) => `Access will be sent to ${host}.`,
		loopback: 'This sends access to an app on this computer. Continue only if you just started connecting from it.',
		unverified: 'This app’s name is not verified.',
		invalid: 'Wrong or expired code. Show a new code in Slate.',
		rateLimited: 'Too many attempts. Wait fifteen minutes, then show a new code in Slate.',
		expired: 'This page has expired. Start connecting again from your AI.',
		broken: 'This connection request is not valid.'
	}
} as const;

function pickLang(request: Request): Lang {
	const header = request.headers.get('Accept-Language') ?? '';
	return /^\s*fr\b/i.test(header) ? 'fr' : 'en';
}

const STYLES = `
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px 20px;background:#0c0c0d;color:#ececee;
font:16px/1.7 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",sans-serif;font-feature-settings:'kern' 1,'liga' 1}
main{width:100%;max-width:30rem}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:40px;font-weight:600;letter-spacing:-0.01em;color:#ececee}
.brand i{width:10px;height:10px;border-radius:3px;background:#d2261c}
h1{margin:0 0 16px;font-size:clamp(28px,6vw,38px);line-height:1.12;font-weight:750;letter-spacing:-0.03em}
p{margin:0 0 16px;color:#a5a5ab;max-width:60ch}
.card{margin-top:32px;padding:28px;border-radius:24px;border:1px solid rgba(255,255,255,.08);background:#141416}
label{display:block;margin-bottom:10px;font-size:14px;font-weight:600;color:#ececee}
input[name=code]{width:100%;padding:16px 18px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:#0c0c0d;color:#fff;
font:600 30px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.35em;text-align:center;transition:all .2s ease-out}
input[name=code]:focus{outline:none;border-color:#d2261c;box-shadow:0 0 0 4px rgba(210,38,28,.22)}
.error{margin:14px 0 0;color:#ff8a80;font-size:14px}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}
button{flex:1 1 140px;padding:14px 24px;border-radius:14px;font-family:inherit;font-size:15px;font-weight:600;line-height:1;cursor:pointer;transition:all .2s ease-out}
button[value=approve]{border:0;background:#d2261c;color:#fff}
button[value=approve]:hover{background:#e0342a;transform:scale(1.02)}
button[value=deny]{border:1px solid rgba(255,255,255,.14);background:transparent;color:#ececee}
button[value=deny]:hover{background:rgba(255,255,255,.06)}
button:focus-visible{outline:2px solid #fff;outline-offset:3px}
.meta{margin-top:24px;font-size:13px;color:#7c7c84}
.warn{color:#ffb74d}
`;

function page(lang: Lang, title: string, body: string): string {
	return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body><main><div class="brand"><i></i>Slate</div>${body}</main></body>
</html>`;
}

function consentPage(lang: Lang, details: ConsentDescription, handle: string, retry: string, error?: string): string {
	const t = TEXT[lang];
	const title = escapeHtml(t.title(details.clientName));
	const notes = [
		escapeHtml(t.destination(details.redirectHost)),
		details.clientDomain ? '' : escapeHtml(t.unverified),
		details.redirectIsLoopback ? `<span class="warn">${escapeHtml(t.loopback)}</span>` : ''
	]
		.filter(Boolean)
		.join(' ');
	const errorBlock = error ? `<p class="error" id="code-error" role="alert">${escapeHtml(error)}</p>` : '';
	return page(
		lang,
		title,
		`<h1>${title}</h1>
<p>${escapeHtml(t.lead(details.clientName))}</p>
<p>${escapeHtml(t.steps)}</p>
<form method="post" class="card">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<input type="hidden" name="retry" value="${escapeHtml(retry)}">
<label for="code">${escapeHtml(t.codeLabel)}</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus${error ? ' aria-describedby="code-error"' : ''}>
${errorBlock}
<div class="actions">
<button type="submit" name="decision" value="approve">${escapeHtml(t.allow)}</button>
<button type="submit" name="decision" value="deny" formnovalidate>${escapeHtml(t.deny)}</button>
</div>
<p class="meta">${notes}</p>
</form>`
	);
}

function messagePage(lang: Lang, message: string, status: number): Response {
	return new Response(page(lang, 'Slate', `<h1>Slate</h1><p>${escapeHtml(message)}</p>`), {
		status,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
			'X-Frame-Options': 'DENY'
		}
	});
}

function htmlResponse(html: string, headers: Headers, status = 200): Response {
	headers.set('Content-Type', 'text/html; charset=utf-8');
	headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
	headers.set('Cache-Control', 'no-store');
	return new Response(html, { status, headers });
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
	const lang = pickLang(request);
	const t = TEXT[lang];
	const oauth = env.OAUTH_PROVIDER;
	try {
		if (request.method === 'GET') {
			const url = new URL(request.url);
			const errorCode = url.searchParams.get(RETRY_ERROR_PARAM);
			url.searchParams.delete(RETRY_ERROR_PARAM);
			const authRequest = await oauth.parseAuthRequest(new Request(url, request));
			const details = await oauth.describeConsent(authRequest);
			const consent = await oauth.beginConsent(authRequest);
			const error = errorCode === 'rate_limited' ? t.rateLimited : errorCode === 'invalid' ? t.invalid : undefined;
			return htmlResponse(consentPage(lang, details, consent.handle, url.search, error), consent.headers);
		}
		if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

		const form = await request.formData();
		const handle = String(form.get('handle') ?? '');
		if (form.get('decision') !== 'approve') {
			const denied = await oauth.denyConsent(request, handle);
			denied.headers.set('Location', denied.redirectTo);
			return new Response(null, { status: 302, headers: denied.headers });
		}

		const clientKey = request.headers.get('CF-Connecting-IP') ?? 'local';
		const registry = env.PAIRING.get(env.PAIRING.idFromName('global'));
		const pairing = await registry.consume(String(form.get('code') ?? ''), clientKey);
		if ('error' in pairing) {
			// La demande OAuth d'origine est revalidée en entier par parseAuthRequest au GET suivant.
			const retry = String(form.get('retry') ?? '');
			if (!retry.startsWith('?')) return messagePage(lang, t.expired, 400);
			const target = new URL(`/authorize${retry}`, request.url);
			target.searchParams.set(RETRY_ERROR_PARAM, pairing.error);
			return Response.redirect(target.toString(), 303);
		}

		const approved = await oauth.approveConsent(request, handle);
		const details = await oauth.describeConsent(approved.request);
		const props: GrantProps = { deviceId: pairing.deviceId, clientName: details.clientName };
		const { redirectTo } = await oauth.completeAuthorization({
			request: approved.request,
			userId: pairing.deviceId,
			metadata: { clientName: details.clientName, redirectHost: details.redirectHost },
			scope: approved.request.scope,
			props
		});
		const hub = env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(pairing.deviceId));
		await hub.notify({ type: 'clients_changed' });
		approved.headers.set('Location', redirectTo);
		return new Response(null, { status: 302, headers: approved.headers });
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
		if (error instanceof AuthorizationError) return messagePage(lang, request.method === 'POST' ? t.expired : t.broken, 400);
		if (error instanceof CimdFetchError) return messagePage(lang, t.broken, 400);
		throw error;
	}
}
