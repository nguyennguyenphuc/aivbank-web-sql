const apiBaseUrl = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001';
const healthUrl = process.env.API_HEALTH_URL ?? new URL('/api/health', apiBaseUrl).toString();
const timeoutMs = Number(process.env.API_STARTUP_TIMEOUT_MS ?? 30_000);
const pollIntervalMs = 150;

async function waitForApi(): Promise<void> {
  const startedAt = Date.now();
  let lastStatus: number | undefined;

  console.log(`Waiting for API health at ${healthUrl}`);
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      lastStatus = response.status;
      if (response.ok) {
        console.log('API is healthy; starting Vite');
        return;
      }
    } catch {
      // The API process may still be compiling or binding its port.
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  const detail = lastStatus ? `last status ${lastStatus}` : 'no response';
  throw new Error(`API did not become healthy within ${timeoutMs}ms (${detail})`);
}

void waitForApi().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
