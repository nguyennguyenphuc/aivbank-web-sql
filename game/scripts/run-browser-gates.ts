import 'dotenv/config';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const suite = process.argv[2] ?? 'e2e';
const webUrl = 'http://127.0.0.1:3300';
const apiUrl = 'http://127.0.0.1:3301';
const processes: ChildProcess[] = [];

async function waitFor(url: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(url)).ok) return; } catch { /* service is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function start(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const child = spawn(command, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', data => process.stderr.write(data));
  processes.push(child);
}

async function playwrightModule(): Promise<{ chromium: { launch: (options: unknown) => Promise<any> } }> {
  const candidates = [
    '/opt/homebrew/lib/node_modules/playwright/index.mjs',
    '/usr/local/lib/node_modules/playwright/index.mjs',
  ];
  const modulePath = candidates.find(candidate => fs.existsSync(candidate));
  if (!modulePath) throw new Error('Playwright is not installed; install it globally or add it to devDependencies');
  return await import(pathToFileURL(modulePath).href) as never;
}

async function login(page: any, email: string): Promise<void> {
  await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
  const emailInput = page.getByLabel('Email');
  const passwordInput = page.getByLabel('Mật khẩu');
  const password = 'AcademyDemo!2026';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await emailInput.inputValue() !== email) await emailInput.fill(email);
    await page.waitForTimeout(100);
    if (await passwordInput.inputValue() !== password) await passwordInput.fill(password);
    await page.waitForTimeout(100);
    if (await emailInput.inputValue() === email && await passwordInput.inputValue() === password) break;
  }
  if (await emailInput.inputValue() !== email || await passwordInput.inputValue() !== password) throw new Error('Login form did not retain controlled input values');
  await page.getByRole('button', { name: 'Đăng nhập lớp học' }).click();
  await page.waitForSelector('#btn-level-pin-1');
}

async function guest(page: any): Promise<void> {
  await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
  const button = page.getByRole('button', { name: 'Chơi ngay với tư cách khách' });
  await button.waitFor();
  await button.click();
  await page.waitForSelector('#btn-level-pin-1');
}

async function classroomAnalysisJourney(browser: any): Promise<Record<string, unknown>> {
  const className = `Journey Gate ${Date.now()}`;
  const teacherContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const teacherPage = await teacherContext.newPage();
  await login(teacherPage, 'admin@jelly.local');
  await teacherPage.goto(`${webUrl}/#/classroom`);
  await teacherPage.getByText('Jelly Trail Classroom').waitFor();
  await teacherPage.locator('#classroom-name').fill(className);
  await teacherPage.getByRole('button', { name: 'Tạo lớp' }).click();
  const teacherClassCard = teacherPage.locator('section').filter({ has: teacherPage.getByRole('heading', { name: 'Lớp của tôi' }) }).locator('article').filter({ hasText: className }).first();
  await teacherClassCard.waitFor();
  const joinCode = (await teacherClassCard.locator('strong').innerText()).trim();
  if (!/^[A-F0-9]{8}$/.test(joinCode)) throw new Error(`Invalid classroom join code: ${joinCode}`);
  await teacherClassCard.locator('[data-testid^="assign-"]').click();
  await teacherPage.getByText('Đã giao:', { exact: false }).waitFor();

  const studentContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const studentPage = await studentContext.newPage();
  await login(studentPage, 'student@jelly.local');
  await studentPage.goto(`${webUrl}/#/classroom`);
  await studentPage.getByText('Jelly Trail Classroom').waitFor();
  await studentPage.locator('#classroom-join-code').fill(joinCode);
  await studentPage.getByRole('button', { name: 'Tham gia' }).click();
  await studentPage.getByText(`Đã vào lớp ${className}.`).waitFor();
  const assignmentCard = studentPage.locator('[data-testid^="assignment-"]').filter({ hasText: className }).first();
  await assignmentCard.getByRole('button', { name: 'Bắt đầu journey' }).click();
  await studentPage.getByText('1. Brief & giả thuyết').waitFor({ timeout: 30_000 });

  const requiredEvidence = [2, 2, 2, 2, 3, 2, 2, 2, 1, 3];
  const narrative = 'Dữ liệu cho thấy thay đổi rõ giữa baseline, regression và hotfix trong đúng lát cắt Android SEA. Tôi liên kết claim với evidence, sample size và data maturity; đồng thời nêu uncertainty, giả thuyết thay thế, guardrail và cách kiểm chứng trước khi đưa ra quyết định rollout.';
  for (let index = 0; index < requiredEvidence.length; index++) {
    await studentPage.locator('#analysis-narrative').fill(`${index + 1}. ${narrative}`);
    const evidenceCards = studentPage.locator('button[data-testid^="evidence-"]');
    if (await evidenceCards.count() < requiredEvidence[index]) throw new Error(`Step ${index + 1} does not expose enough evidence`);
    for (let evidenceIndex = 0; evidenceIndex < requiredEvidence[index]; evidenceIndex++) await evidenceCards.nth(evidenceIndex).click();
    if (index === requiredEvidence.length - 1) break;
    if (index === 0) {
      const savePattern = '**/api/v1/classrooms/assignments/*/steps/brief';
      const draftBeforeFailure = await studentPage.locator('#analysis-narrative').inputValue();
      await studentPage.route(savePattern, (route: any) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Autosave unavailable' }) }));
      await studentPage.getByRole('button', { name: 'Tiếp →' }).click();
      await studentPage.getByText('Request failed with 503').waitFor();
      if (!await studentPage.getByText('1. Brief & giả thuyết').isVisible()) throw new Error('Autosave failure advanced to another step');
      if (await studentPage.locator('#analysis-narrative').inputValue() !== draftBeforeFailure) throw new Error('Autosave failure discarded the dirty draft');
      await studentPage.unroute(savePattern);

      let markSlowSaveStarted!: () => void;
      let releaseSlowSave!: () => void;
      const slowSaveStarted = new Promise<void>(resolve => { markSlowSaveStarted = resolve; });
      const slowSaveReleased = new Promise<void>(resolve => { releaseSlowSave = resolve; });
      await studentPage.route(savePattern, async (route: any) => {
        markSlowSaveStarted();
        await slowSaveReleased;
        await route.continue();
      });
      const slowNavigation = studentPage.getByRole('button', { name: 'Tiếp →' }).click();
      await slowSaveStarted;
      const draftDuringSave = `${draftBeforeFailure} Thay đổi mới được nhập trong lúc request đang chờ.`;
      await studentPage.locator('#analysis-narrative').fill(draftDuringSave);
      const slowResponse = studentPage.waitForResponse(savePattern);
      releaseSlowSave();
      await Promise.all([slowNavigation, slowResponse]);
      await studentPage.getByText('Bạn có thay đổi mới chưa được lưu.').waitFor();
      if (!await studentPage.getByText('1. Brief & giả thuyết').isVisible()) throw new Error('Slow autosave navigated away despite a newer local draft');
      if (await studentPage.locator('#analysis-narrative').inputValue() !== draftDuringSave) throw new Error('Slow autosave overwrote a newer local draft');
      await studentPage.unroute(savePattern);
    }
    await studentPage.getByRole('button', { name: 'Tiếp →' }).click();
    await studentPage.getByText(`Bước ${index + 2}/10`, { exact: false }).waitFor();
    if (index === 0) {
      await studentPage.reload();
      await studentPage.getByRole('button', { name: 'Đang làm · tiếp tục' }).click();
      await studentPage.getByText('2. Activity & engagement').waitFor();
    }
  }
  await studentPage.locator('[data-testid="submit-analysis"]').click();
  await studentPage.locator('[data-testid="analysis-result"]').waitFor({ timeout: 20_000 });
  const scoreText = await studentPage.locator('[data-testid="analysis-result"] h1').innerText();
  const score = Number(scoreText.split('/')[0]);
  if (!Number.isFinite(score) || score < 80) throw new Error(`Analysis result score is invalid: ${scoreText}`);
  await studentContext.close();

  await teacherPage.reload();
  const trackingSection = teacherPage.locator('section[aria-labelledby="teacher-assignments-title"]');
  const trackingClass = trackingSection.locator('article').filter({ hasText: className }).first();
  await trackingClass.locator('[data-testid^="progress-"]').click();
  const progress = teacherPage.locator('[data-testid="teacher-progress"]');
  await progress.waitFor();
  const progressText = await progress.innerText();
  if (!progressText.includes('100%') || !progressText.includes('submitted') || !progressText.includes('10/10')) throw new Error(`Teacher progress is incomplete: ${progressText}`);
  await teacherContext.close();
  return { created: true, joined: true, resumedAfterReload: true, submitted: true, teacherProgress: true, score };
}

async function e2e(browser: any): Promise<Record<string, unknown>> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (message: any) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await guest(page);
  await page.locator('#btn-open-shop').click();
  const hammerRow = page.locator('#btn-buy-hammer').locator('..');
  const shopHeader = page.locator('#btn-close-shop').locator('..');
  await hammerRow.getByText('Đang có: 3').waitFor();
  await page.locator('#btn-claim-free-coins').click();
  await shopHeader.getByText('400', { exact: true }).waitFor();
  let shopPurchaseRequests = 0;
  const shopPurchasePattern = '**/api/v1/commerce/buy';
  await page.route(shopPurchasePattern, async (route: any) => {
    shopPurchaseRequests++;
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.continue();
  });
  const buyHammer = page.locator('#btn-buy-hammer');
  await Promise.all([buyHammer.dispatchEvent('click'), buyHammer.dispatchEvent('click')]);
  await hammerRow.getByText('Đang có: 5').waitFor();
  await shopHeader.getByText('300', { exact: true }).waitFor();
  await page.unroute(shopPurchasePattern);
  if (shopPurchaseRequests !== 1) throw new Error(`Rapid double click issued ${shopPurchaseRequests} shop purchase requests`);
  await page.locator('#btn-close-shop').click();
  await page.locator('#btn-open-spin').click();
  await page.locator('#btn-start-spin').click();
  await page.locator('#btn-claim-spin').waitFor({ timeout: 10_000 });
  await page.locator('#btn-claim-spin').click();
  await page.locator('#btn-level-pin-1').dispatchEvent('click');
  await page.locator('#btn-start-level-play').waitFor();
  await page.locator('#btn-start-level-play').dispatchEvent('click');
  await page.getByText('Thử thách xếp hạng', { exact: false }).waitFor();
  if (await page.locator('#btn-booster-hammer').count() !== 0) throw new Error('Ranked flow should not expose boosters');
  const tiles = page.locator('button[aria-label*=","]');
  if (await tiles.count() < 25) throw new Error('Ranked board did not render enough cells');
  const movesBefore = Number((await page.locator('#ranked-moves-remaining').innerText()).match(/\d+/)?.[0]);
  const swipe = await page.evaluate(`(() => {
    const cells = [...document.querySelectorAll('.ranked-candy-board button[data-row][data-col]')];
    const byPosition = new Map(cells.map(cell => [cell.dataset.row + ':' + cell.dataset.col, cell]));
    const colors = new Map(cells.map(cell => [cell.dataset.row + ':' + cell.dataset.col, cell.dataset.color]));
    const rows = Math.max(...cells.map(cell => Number(cell.dataset.row))) + 1;
    const cols = Math.max(...cells.map(cell => Number(cell.dataset.col))) + 1;
    const colorAt = (row, col) => colors.get(row + ':' + col);
    const hasMatchAt = (row, col) => {
      const color = colorAt(row, col);
      if (!color) return false;
      let horizontal = 1;
      let vertical = 1;
      for (let next = col - 1; next >= 0 && colorAt(row, next) === color; next--) horizontal++;
      for (let next = col + 1; next < cols && colorAt(row, next) === color; next++) horizontal++;
      for (let next = row - 1; next >= 0 && colorAt(next, col) === color; next--) vertical++;
      for (let next = row + 1; next < rows && colorAt(next, col) === color; next++) vertical++;
      return horizontal >= 3 || vertical >= 3;
    };
    for (const cell of cells) {
      if (cell.disabled || !cell.dataset.color) continue;
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      for (const [rowDelta, colDelta] of [[0, 1], [1, 0]]) {
        const targetRow = row + rowDelta;
        const targetCol = col + colDelta;
        const target = byPosition.get(targetRow + ':' + targetCol);
        if (!target || target.disabled || !target.dataset.color) continue;
        const sourceKey = row + ':' + col;
        const targetKey = targetRow + ':' + targetCol;
        const sourceColor = colors.get(sourceKey);
        colors.set(sourceKey, colors.get(targetKey));
        colors.set(targetKey, sourceColor);
        const valid = hasMatchAt(row, col) || hasMatchAt(targetRow, targetCol);
        colors.set(targetKey, colors.get(sourceKey));
        colors.set(sourceKey, sourceColor);
        if (!valid) continue;
        const from = cell.getBoundingClientRect();
        const to = target.getBoundingClientRect();
        return { from: { x: from.x + from.width / 2, y: from.y + from.height / 2 }, to: { x: to.x + to.width / 2, y: to.y + to.height / 2 } };
      }
    }
    return null;
  })()`) as { from: { x: number; y: number }; to: { x: number; y: number } } | null;
  if (!swipe) throw new Error('Could not find a legal swipe on the ranked board');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: swipe.from.x, y: swipe.from.y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: swipe.to.x, y: swipe.to.y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction((before: number) => Number(document.querySelector('#ranked-moves-remaining')?.textContent?.match(/\d+/)?.[0]) === before - 1, movesBefore);
  const movesAfter = Number((await page.locator('#ranked-moves-remaining').innerText()).match(/\d+/)?.[0]);
  const scoreAfter = Number((await page.locator('#ranked-score').innerText()).replace(/\D/g, ''));
  if (movesAfter !== movesBefore - 1 || scoreAfter <= 0) throw new Error(`Ranked swipe was not atomic: moves=${movesBefore}->${movesAfter} score=${scoreAfter}`);
  await page.locator('#btn-ranked-game-back').waitFor({ timeout: 10_000 });
  await page.locator('#btn-ranked-game-back').click();
  await page.locator('#btn-level-pin-1').dispatchEvent('click');
  await page.locator('#btn-start-practice-level').waitFor();
  await page.locator('#btn-start-practice-level').click();
  await page.locator('#btn-booster-hammer').waitFor({ timeout: 10_000 });
  const practiceMoves = page.locator('[data-testid="practice-moves-remaining"]');
  const practiceTiles = page.locator('[data-testid^="practice-tile-"]');
  const practiceMovesStart = Number((await practiceMoves.innerText()).match(/\d+/)?.[0]);
  const practiceTileCountStart = await practiceTiles.count();
  if (!Number.isFinite(practiceMovesStart) || practiceMovesStart <= 0) throw new Error(`Practice moves are invalid: ${await practiceMoves.innerText()}`);
  if (practiceTileCountStart < 25) throw new Error(`Practice board did not render enough tiles: ${practiceTileCountStart}`);
  const boosterCount = async (type: 'hammer' | 'lightning' | 'shuffle' | 'extraMoves') => Number((await page.locator(`#btn-booster-${type} span.absolute`).innerText()).replace(/\D/g, ''));
  const hammerStart = await boosterCount('hammer');
  const lightningStart = await boosterCount('lightning');
  const shuffleStart = await boosterCount('shuffle');
  const extraMovesStart = await boosterCount('extraMoves');
  if ([hammerStart, lightningStart, shuffleStart, extraMovesStart].some(value => !Number.isFinite(value) || value <= 0)) throw new Error(`Practice booster counts are invalid: ${JSON.stringify({ hammerStart, lightningStart, shuffleStart, extraMovesStart })}`);

  await page.locator('#btn-booster-shuffle').click();
  await page.waitForFunction((before: number) => Number(document.querySelector('#btn-booster-shuffle span.absolute')?.textContent?.replace(/\D/g, '') ?? '') === before - 1, shuffleStart);
  const movesAfterShuffle = Number((await practiceMoves.innerText()).match(/\d+/)?.[0]);
  if (movesAfterShuffle !== practiceMovesStart) throw new Error(`Shuffle should not change moves: ${practiceMovesStart} -> ${movesAfterShuffle}`);

  const movesBeforeExtra = Number((await practiceMoves.innerText()).match(/\d+/)?.[0]);
  await page.locator('#btn-booster-extraMoves').click();
  await page.waitForFunction((before: number) => Number(document.querySelector('#btn-booster-extraMoves span.absolute')?.textContent?.replace(/\D/g, '') ?? '') === before - 1, extraMovesStart);
  await page.waitForFunction((before: number) => Number(document.querySelector('[data-testid="practice-moves-remaining"]')?.textContent?.match(/\d+/)?.[0]) === before + 5, movesBeforeExtra);
  const movesAfterExtra = Number((await practiceMoves.innerText()).match(/\d+/)?.[0]);
  if (movesAfterExtra !== movesBeforeExtra + 5) throw new Error(`Extra moves should add 5 turns: ${movesBeforeExtra} -> ${movesAfterExtra}`);

  let hammerRequests = 0;
  const boosterUsePattern = '**/api/v1/economy/use-booster';
  await page.route(boosterUsePattern, async (route: any) => {
    hammerRequests++;
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.continue();
  });
  await page.locator('#btn-booster-hammer').click();
  const hammerTile = page.locator('[data-testid="practice-tile-0-0"]');
  await Promise.all([hammerTile.dispatchEvent('click'), hammerTile.dispatchEvent('click')]);
  await page.waitForFunction((before: number) => Number(document.querySelector('#btn-booster-hammer span.absolute')?.textContent?.replace(/\D/g, '') ?? '') === before - 1, hammerStart);
  await page.unroute(boosterUsePattern);
  if (hammerRequests !== 1) throw new Error(`Rapid double tap issued ${hammerRequests} hammer requests`);
  await page.waitForFunction((expected: number) => document.querySelectorAll('[data-testid^="practice-tile-"]').length === expected, practiceTileCountStart);
  const movesAfterHammer = Number((await practiceMoves.innerText()).match(/\d+/)?.[0]);
  if (movesAfterHammer !== movesAfterExtra) throw new Error(`Hammer should not change moves: ${movesAfterExtra} -> ${movesAfterHammer}`);

  // Destructive boosters can legitimately finish level 1. Leave immediately
  // after the hammer so lightning is validated in a fresh practice session.
  await page.locator('#btn-game-back').dispatchEvent('click');
  await page.locator('#btn-level-pin-1').waitFor();
  await page.locator('#btn-level-pin-1').dispatchEvent('click');
  await page.locator('#btn-start-practice-level').click();
  await page.locator('#btn-booster-lightning').waitFor({ timeout: 10_000 });
  const lightningMovesStart = Number((await page.locator('[data-testid="practice-moves-remaining"]').innerText()).match(/\d+/)?.[0]);
  await page.locator('#btn-booster-lightning').click();
  await page.locator('[data-testid="practice-tile-0-1"]').click();
  await page.waitForFunction((before: number) => Number(document.querySelector('#btn-booster-lightning span.absolute')?.textContent?.replace(/\D/g, '') ?? '') === before - 1, lightningStart);
  await page.waitForFunction((expected: number) => document.querySelectorAll('[data-testid^="practice-tile-"]').length === expected, practiceTileCountStart);
  const movesAfterLightning = Number((await page.locator('[data-testid="practice-moves-remaining"]').innerText()).match(/\d+/)?.[0]);
  if (movesAfterLightning !== lightningMovesStart) throw new Error(`Lightning should not change moves: ${lightningMovesStart} -> ${movesAfterLightning}`);

  await page.locator('#btn-game-back').dispatchEvent('click');
  await page.locator('#btn-level-pin-1').waitFor();
  await page.locator('#btn-level-pin-1').dispatchEvent('click');
  await page.locator('#btn-start-practice-level').click();
  await page.locator('#btn-booster-hammer').waitFor({ timeout: 10_000 });
  const persistedCounts = {
    hammer: Number((await page.locator('#btn-booster-hammer span.absolute').innerText()).replace(/\D/g, '')),
    lightning: Number((await page.locator('#btn-booster-lightning span.absolute').innerText()).replace(/\D/g, '')),
    shuffle: Number((await page.locator('#btn-booster-shuffle span.absolute').innerText()).replace(/\D/g, '')),
    extraMoves: Number((await page.locator('#btn-booster-extraMoves span.absolute').innerText()).replace(/\D/g, '')),
  };
  if (persistedCounts.hammer !== hammerStart - 1 || persistedCounts.lightning !== lightningStart - 1 || persistedCounts.shuffle !== shuffleStart - 1 || persistedCounts.extraMoves !== extraMovesStart - 1) {
    throw new Error(`Persisted inventory mismatch: ${JSON.stringify({ hammerStart, lightningStart, shuffleStart, extraMovesStart, persistedCounts })}`);
  }
  await page.screenshot({ path: '/tmp/jelly-trail-ranked-mobile.png', fullPage: true });
  await context.close();

  const analystContext = await browser.newContext();
  const analystPage = await analystContext.newPage();
  await login(analystPage, 'analyst@jelly.local');
  await analystPage.goto(`${webUrl}/#/analyst`);
  await analystPage.getByText('Product Health Lab').waitFor();
  await analystContext.close();

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await login(adminPage, 'admin@jelly.local');
  await adminPage.goto(`${webUrl}/#/admin`);
  await adminPage.getByText('Live Service Console').waitFor();
  await adminPage.getByText('13/13 tables', { exact: false }).waitFor();
  await adminContext.close();
  const classroomJourney = await classroomAnalysisJourney(browser);
  if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.join(' | ')}`);
  return {
    guestRanked: true,
    rankedSwipeAtomic: true,
    backendEconomy: true,
    practiceBoosters: {
      hammer: true,
      lightning: true,
      shuffle: true,
      extraMoves: true,
      movesPreservedForNonMoveBoosters: true,
      inventoryPersisted: true,
      persistedCounts,
    },
    analyst: true,
    admin: true,
    classroomJourney,
    screenshot: '/tmp/jelly-trail-ranked-mobile.png',
  };
}

async function a11y(browser: any): Promise<Record<string, unknown>> {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await guest(page);
  const viewportContent = await page.locator('meta[name="viewport"]').getAttribute('content') ?? '';
  const normalizedViewport = viewportContent.toLowerCase().replace(/\s/g, '');
  const zoomLocked = normalizedViewport.includes('user-scalable=no') || normalizedViewport.includes('maximum-scale=1');
  const audit = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const unnamedButtons = buttons.filter(button => !(button.getAttribute('aria-label') || button.textContent?.trim())).length;
    const headings = document.querySelectorAll('h1').length;
    const horizontalOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
    const tinyTargets = buttons.filter(button => { const box = button.getBoundingClientRect(); return box.width > 0 && box.height > 0 && (box.width < 32 || box.height < 32); }).length;
    return { buttons: buttons.length, unnamedButtons, headings, horizontalOverflow, tinyTargets };
  });

  const settingsTrigger = page.locator('#btn-open-settings');
  await settingsTrigger.focus();
  await settingsTrigger.click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await dialog.waitFor();
  const initialFocusInsideDialog = await page.evaluate(() => {
    const active = document.activeElement;
    return Boolean(active && active.closest('[role="dialog"][aria-modal="true"]'));
  });
  await page.keyboard.press('Shift+Tab');
  const trappedFocusInsideDialog = await page.evaluate(() => {
    const active = document.activeElement;
    return Boolean(active && active.closest('[role="dialog"][aria-modal="true"]'));
  });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  const focusRestored = await settingsTrigger.evaluate((element: HTMLElement) => document.activeElement === element);

  await page.locator('#btn-level-pin-1').click();
  await page.locator('#btn-start-level-play').click();
  await page.getByText('Thử thách xếp hạng', { exact: false }).waitFor();
  const rankedCellLabels = await page.locator('.ranked-candy-board button[data-row][data-col]').evaluateAll((cells: HTMLElement[]) => cells.map(cell => cell.getAttribute('aria-label') ?? ''));
  const rankedCellsDescribed = rankedCellLabels.length >= 25 && rankedCellLabels.every(label => /(?:hàng|row)\s+\d+/i.test(label) && /(?:cột|column)\s+\d+/i.test(label));
  await context.close();
  const result = { ...audit, zoomLocked, initialFocusInsideDialog, trappedFocusInsideDialog, focusRestored, rankedCellsDescribed, rankedCellCount: rankedCellLabels.length };
  if (audit.unnamedButtons || !audit.headings || audit.horizontalOverflow || audit.tinyTargets > 2 || zoomLocked || !initialFocusInsideDialog || !trappedFocusInsideDialog || !focusRestored || !rankedCellsDescribed) {
    throw new Error(`Accessibility audit failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function perf(browser: any): Promise<Record<string, unknown>> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const started = Date.now();
  await guest(page);
  const interactiveMs = Date.now() - started;
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({ name: entry.name, duration: entry.duration, size: (entry as PerformanceResourceTiming).transferSize })));
  const transferred = resources.reduce((sum: number, item: { size: number }) => sum + item.size, 0);
  await context.close();
  if (interactiveMs > 5000 || transferred > 2_000_000) throw new Error(`Performance budget failed: interactive=${interactiveMs} bytes=${transferred}`);
  return { interactiveMs, transferredBytes: transferred, resources: resources.length };
}

async function security(): Promise<Record<string, unknown>> {
  const ready = await fetch(`${apiUrl}/api/ready`);
  const unauthorized = await fetch(`${apiUrl}/api/v1/exports/compatibility-status`);
  const required = ['x-content-type-options', 'content-security-policy', 'referrer-policy', 'permissions-policy'];
  const missing = required.filter(header => !ready.headers.get(header));
  if (missing.length || unauthorized.status !== 401) throw new Error(`Security gate failed: missing=${missing.join(',')} unauthorized=${unauthorized.status}`);
  const sw = await (await fetch(`${webUrl}/sw.js`)).text();
  if (!sw.includes("url.pathname.startsWith('/api/')")) throw new Error('Service worker may cache API responses');
  return { headers: required, unauthorizedStatus: unauthorized.status, apiExcludedFromServiceWorker: true };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for browser gates');
  start('node', ['server/dist/main.js'], { PORT: '3301', HOST: '127.0.0.1', WEB_ORIGIN: webUrl, SESSION_SECRET: 'browser-gate-session-secret', TELEMETRY_HASH_SECRET: 'browser-gate-telemetry-secret' });
  start('npx', ['vite', 'preview', '--port', '3300', '--host', '127.0.0.1'], { API_PROXY_TARGET: apiUrl });
  try {
    await Promise.all([waitFor(`${apiUrl}/api/ready`), waitFor(webUrl)]);
    if (suite === 'security') return console.log(JSON.stringify({ ok: true, suite, result: await security() }));
    const { chromium } = await playwrightModule();
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const result = suite === 'a11y' ? await a11y(browser) : suite === 'perf' ? await perf(browser) : await e2e(browser);
      console.log(JSON.stringify({ ok: true, suite, result }));
    } finally { await browser.close(); }
  } finally {
    processes.forEach(process => process.kill('SIGTERM'));
  }
}

void main();
