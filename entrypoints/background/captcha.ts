/**
 * reCAPTCHA solving — talks to the MAIN world content script to call
 * `grecaptcha.enterprise.execute` and pull a fresh token from the active
 * Flow tab.
 */

export const FLOW_TAB_URLS = [
  'https://labs.google/fx/tools/flow*',
  'https://labs.google/fx/*/tools/flow*',
] as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function requestCaptchaFromTab(
  tabId: number,
  requestId: string,
  pageAction: string,
): Promise<{ token?: string; error?: string }> {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  } catch (error) {
    const msg = (error as Error | undefined)?.message ?? '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/flow-bridge.js'],
    });
    await sleep(200);
    return chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  }
}

export async function solveCaptcha(
  requestId: string,
  captchaAction: string,
): Promise<{ token?: string; error?: string }> {
  const tabs = await chrome.tabs.query({ url: [...FLOW_TAB_URLS] });

  if (!tabs.length) {
    try {
      await chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow', active: false });
      await sleep(3000);
      const retryTabs = await chrome.tabs.query({ url: [...FLOW_TAB_URLS] });
      if (!retryTabs.length) return { error: 'NO_FLOW_TAB' };
      const tabId = retryTabs[0]!.id!;
      const resp = await Promise.race<{ token?: string; error?: string }>([
        requestCaptchaFromTab(tabId, requestId, captchaAction),
        new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30_000)),
      ]);
      return resp;
    } catch (e) {
      return { error: (e as Error).message || 'NO_FLOW_TAB' };
    }
  }

  try {
    const tabId = tabs[0]!.id!;
    const resp = await Promise.race<{ token?: string; error?: string }>([
      requestCaptchaFromTab(tabId, requestId, captchaAction),
      new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30_000)),
    ]);
    return resp;
  } catch (e) {
    return { error: (e as Error).message };
  }
}
