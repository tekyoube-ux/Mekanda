export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.searchParams.get('path');

    if (!path) return new Response('Missing path', { status: 400 });

    const CF_APP_ID = env.VITE_CLOUDFLARE_APP_ID?.trim();
    const CF_TOKEN = env.VITE_CLOUDFLARE_API_TOKEN?.trim();

    if (!CF_APP_ID || !CF_TOKEN) {
        return new Response(JSON.stringify({
            error: 'Cloudflare environment variables are missing',
            appIdSet: !!CF_APP_ID,
            tokenSet: !!CF_TOKEN
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const targetUrl = `https://rtc.live.cloudflare.com/v1/apps/${CF_APP_ID}/${path}`;

    try {
        const bodyText = (request.method !== 'GET' && request.method !== 'HEAD') ? await request.text() : undefined;
        const finalToken = CF_TOKEN.toLowerCase().startsWith('bearer ') ? CF_TOKEN.substring(7).trim() : CF_TOKEN;

        const response = await fetch(targetUrl, {
            method: request.method,
            headers: {
                'Authorization': `Bearer ${finalToken}`,
                'Content-Type': 'application/json'
            },
            body: bodyText
        });

        const contentType = response.headers.get('content-type') || '';
        let responseData;

        if (contentType.includes('application/json')) {
            responseData = await response.json();
        } else {
            responseData = { rawText: await response.text() };
        }

        if (!response.ok) {
            return new Response(JSON.stringify({
                error: 'Cloudflare upstream error',
                status: response.status,
                upstreamResponse: responseData,
                env_diag: {
                    appId: CF_APP_ID.substring(0, 5) + "..." + CF_APP_ID.substring(CF_APP_ID.length - 5),
                    token: CF_TOKEN.substring(0, 5) + "..." + CF_TOKEN.substring(CF_TOKEN.length - 5)
                }
            }), {
                status: response.status,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify(responseData), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
