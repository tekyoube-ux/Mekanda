import { chromium } from 'playwright';

(async () => {
    console.log("Starting debug script...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', msg => console.log('BROWSER_LOG:', msg.type(), msg.text()));
    page.on('pageerror', error => console.log('BROWSER_ERROR:', error));

    try {
        await page.goto('http://localhost:5173/');
        console.log("Page loaded. Waiting 5s for auth state...");
        
        await page.waitForTimeout(5000);
        
        const loginBtn = await page.$('button');
        if (loginBtn) {
            console.log("Found a button. App might be at login screen not auth'd by default in fresh context. Let's see if there's local storage we can push or if we can see the errors!");
        } else {
            console.log("No button found, probably logged in.");
        }
    } catch (err) {
        console.error("Script error:", err);
    } finally {
        await browser.close();
    }
})();
