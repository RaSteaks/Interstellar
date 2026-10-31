// Serve dist/ with Cloudflare's local asset runtime so these checks exercise
// actual HTML redirects and _headers, rather than a second policy implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.argv[2] || 'http://127.0.0.1:18765';
const engine = process.env.PREVIEW_BROWSER || 'webkit';
assert.ok(['firefox', 'webkit'].includes(engine), 'Use headless Firefox or WebKit');
const output = path.join(__dirname, '../verification/preview', engine);
const dist = path.join(__dirname, '../dist');
fs.mkdirSync(output, { recursive: true });
const capture = (page, name) => page.screenshot({ path: path.join(output, name + '.png'), caret: 'initial' });

(async () => {
  const api = await playwright.request.newContext();
  const browser = await playwright[engine].launch({ headless: true });
  const report = {
    browser: engine,
    version: browser.version(),
    method: 'Local Cloudflare static assets; isolated HTTPS parent origins proxy unchanged local GET responses into the browser',
    productionDeploymentVerified: false,
    realParentSiteVerified: false,
    documents: [],
    layouts: [],
    embeds: [],
    errors: [],
  };
  let activePage;
  try {
    for (const pathname of ['/preview', '/preview/', '/preview/index.html', '/preview?card=1']) {
      const first = await api.get(base + pathname, { maxRedirects: 0 });
      const response = await api.get(base + pathname);
      assert.equal(response.status(), 200, pathname);
      assert.equal(new URL(response.url()).pathname, '/preview/');
      assert.match(await response.text(), /id="preview-title"/);
      const policies = response.headersArray().filter(header => header.name.toLowerCase() === 'content-security-policy');
      assert.equal(policies.length, 1, 'Preview must have exactly one enforcing CSP');
      assert.ok(!policies[0].value.includes(','), 'Conflicting combined CSP policies');
      assert.match(policies[0].value, /(?:^|;)\s*frame-ancestors 'self' https:\/\/blog\.rasteaks\.cn:8443(?:;|$)/);
      assert.equal(response.headers()['x-frame-options'], undefined);
      assert.equal(response.headers()['access-control-allow-origin'], undefined);
      assert.equal(response.headers()['x-robots-tag'], 'noindex');
      report.documents.push({ pathname, initialStatus: first.status(), location: first.headers().location, finalURL: response.url(), headers: response.headers() });
    }

    // The new rules must not apply to the homepage, assets or similarly named paths.
    for (const pathname of ['/', '/index.html', '/styles.css', '/preview.css', '/screenshot.jpeg', '/notices.txt', '/preview-other']) {
      const response = await api.get(base + pathname);
      for (const name of ['content-security-policy', 'x-frame-options', 'x-robots-tag']) {
        assert.equal(response.headers()[name], undefined, pathname + ' unexpectedly changed ' + name);
      }
      if (pathname === '/') assert.equal(await response.text(), fs.readFileSync(path.join(dist, 'index.html'), 'utf8'));
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    activePage = page;
    const requests = [];
    const previewMessages = [];
    page.on('request', request => requests.push({ url: request.url(), method: request.method(), type: request.resourceType() }));
    page.on('console', message => previewMessages.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('dialog', async dialog => { report.errors.push('Unexpected dialog: ' + dialog.message()); await dialog.dismiss(); });
    await page.goto(base + '/preview');
    await page.reload();
    assert.equal(new URL(page.url()).pathname, '/preview/');
    assert.equal(await page.title(), 'Interstellar · 黑洞观测站 · 作品预览');
    assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex');
    assert.equal(await page.locator('script, iframe, form, audio, video, canvas').count(), 0);
    await page.waitForLoadState('networkidle');
    assert.ok(requests.every(request => request.method === 'GET' && ['document', 'stylesheet', 'image'].includes(request.type)));
    assert.ok(requests.every(request => new URL(request.url).origin === new URL(base).origin));
    report.previewRequests = requests;

    for (const viewport of [{ width: 1280, height: 800 }, { width: 640, height: 400 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => {
        const image = document.querySelector('.preview-image');
        return {
          width: innerWidth, height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
          imageReady: image.complete && image.naturalWidth > 0,
          caption: document.querySelector('.preview-caption').getBoundingClientRect().toJSON(),
          title: document.querySelector('h1').getBoundingClientRect().toJSON(),
          text: document.querySelector('.preview-description').getBoundingClientRect().toJSON(),
        };
      });
      assert.equal(layout.scrollWidth, viewport.width, 'Horizontal overflow');
      assert.equal(layout.scrollHeight, viewport.height, 'First screen needs scrolling');
      assert.ok(layout.imageReady, 'Project capture did not load');
      for (const box of [layout.caption, layout.title, layout.text]) {
        assert.ok(box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= viewport.width + 1 && box.top >= 0 && box.bottom <= viewport.height + 1, 'Caption outside viewport');
      }
      report.layouts.push(layout);
      await capture(page, 'preview-' + viewport.width + 'x' + viewport.height);
    }
    await context.close();
    report.previewMessages = previewMessages;
    assert.deepEqual(previewMessages.filter(message => message.type === 'error'), []);

    const fallbackContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 800 } });
    const fallback = await fallbackContext.newPage();
    activePage = fallback;
    await fallback.route('**/screenshot.jpeg', route => route.abort());
    await fallback.goto(base + '/preview/');
    assert.ok(await fallback.locator('#preview-title').isVisible());
    assert.match(await fallback.locator('.preview-description').innerText(), /吸积盘.*引力透镜/);
    assert.equal(await fallback.locator('.preview-image').evaluate(image => image.naturalWidth), 0);
    await capture(fallback, 'image-failure-no-js');
    report.fallback = 'Project title and description remain visible without image or JavaScript';
    await fallbackContext.close();

    const previewOrigin = 'https://preview.interstellar.test';
    const cases = [
      { name: 'allowed', origin: 'https://blog.rasteaks.cn:8443', allowed: true, scale: 1 },
      { name: 'allowed-scaled', origin: 'https://blog.rasteaks.cn:8443', allowed: true, scale: .5 },
      { name: 'self', origin: previewOrigin, allowed: true, scale: 1 },
      { name: 'wrong-port', origin: 'https://blog.rasteaks.cn', allowed: false, scale: 1 },
      { name: 'other-origin', origin: 'https://not-allowed.example', allowed: false, scale: 1 },
    ];
    for (const fixture of cases) {
      const embedContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const embed = await embedContext.newPage();
      activePage = embed;
      const messages = [];
      embed.on('console', message => messages.push({ type: message.type(), text: message.text() }));
      embed.on('pageerror', error => report.errors.push(error.message));
      // Interception gives the test parent the EXACT production Origin, including
      // port 8443, without contacting it or adding localhost to the shipped CSP.
      // Child responses retain the local asset runtime's CSP. Use its canonical
      // URL here: WebKit interception cannot fulfill an HTTP redirect response.
      await embedContext.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === fixture.origin && url.pathname === '/embed-test.html') {
          await route.fulfill({
            contentType: 'text/html',
            headers: { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-src " + previewOrigin },
            body: '<!doctype html><html><head><title>Isolated iframe test</title><style>body{margin:0;background:#15181c}iframe{display:block;width:1280px;height:800px;border:0;transform:scale(' + fixture.scale + ');transform-origin:top left}</style></head><body><iframe title="Interstellar preview" src="' + previewOrigin + '/preview/" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe></body></html>',
          });
          return;
        }
        if (url.origin === previewOrigin) {
          const response = await api.get(base + url.pathname + url.search, { maxRedirects: 0 });
          await route.fulfill({ response });
          return;
        }
        await route.abort();
      });
      await embed.goto(fixture.origin + '/embed-test.html');
      await embed.waitForLoadState('networkidle');
      const title = embed.frameLocator('iframe').locator('#preview-title');
      if (fixture.allowed) {
        await title.waitFor({ state: 'visible' });
        const frame = embed.frames().find(frame => frame.url().startsWith(previewOrigin + '/preview/'));
        assert.ok(frame, 'Iframe did not reach the preview document');
        const state = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight, referrer: document.referrer, imageReady: document.querySelector('.preview-image').naturalWidth > 0 }));
        assert.deepEqual(state, { width: 1280, height: 800, referrer: '', imageReady: true });
        if (fixture.scale === .5) {
          const box = await embed.locator('iframe').boundingBox();
          assert.equal(box.width, 640);
          assert.equal(box.height, 400);
        }
      } else {
        assert.equal(await title.count(), 0, 'Unauthorized parent rendered preview');
      }
      await capture(embed, 'embed-' + fixture.name);
      await embedContext.close();
      report.embeds.push({ ...fixture, messages });
      if (fixture.allowed) {
        assert.deepEqual(messages.filter(message => message.type === 'error'), [], 'Allowed embed has browser errors');
      } else {
        assert.ok(messages.some(message => /frame-ancestors/i.test(message.text)), 'Missing browser CSP refusal evidence');
      }
    }

    const homeContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const home = await homeContext.newPage();
    activePage = home;
    home.on('pageerror', error => report.errors.push(error.message));
    await home.goto(base + '/');
    await home.locator('#cosmos').waitFor({ state: 'visible' });
    assert.equal(await home.title(), 'Interstellar · 黑洞观测站');
    assert.equal(await home.locator('.preview').count(), 0);
    await home.locator('.control-toggle').click();
    assert.equal(await home.locator('#scene-choice').inputValue(), 'quasar');
    assert.ok(await home.locator('#controls-title').isVisible());
    await capture(home, 'homepage-controls');
    await homeContext.close();
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.stack;
    if (activePage && !activePage.isClosed()) await capture(activePage, 'failure').catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await browser.close();
    await api.dispose();
  }
  console.log('Preview HTTP, layout, fallback, iframe policy and homepage checks passed (' + engine + '). Evidence: ' + output);
})().catch(error => { console.error(error); process.exitCode = 1; });
