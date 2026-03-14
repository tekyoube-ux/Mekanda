export async function onRequest(context) {
    // Redirect all requests to the versioned v2 bridge for consistency
    return context.env.ASSETS.fetch(new URL('/api/calls_v2' + new URL(context.request.url).search, context.request.url));
}
