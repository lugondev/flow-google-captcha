import { defineConfig } from 'wxt';
import react from '@vitejs/plugin-react';

export default defineConfig({
  srcDir: '.',
  outDir: '.output',

  manifest: {
    name: 'Flow Helper',
    description:
      'Local agent bridge for Google Flow API — captures tokens, solves reCAPTCHA, proxies API calls.',
    // No default_popup: clicking the toolbar icon opens the side panel directly
    // (wired via sidePanel.setPanelBehavior in the background service worker).
    action: { default_title: 'Flow Helper' },
    permissions: [
      'storage',
      'alarms',
      'tabs',
      'webRequest',
      'scripting',
      'declarativeNetRequest',
      'sidePanel',
      'contextMenus',
      'downloads',
    ],
    host_permissions: [
      'https://labs.google/*',
      'https://aisandbox-pa.googleapis.com/*',
      'https://storage.googleapis.com/*',
      'https://flow-content.google/*',
      'http://127.0.0.1:8100/*',
    ],
    web_accessible_resources: [
      {
        resources: ['flow-bridge-main.js'],
        matches: ['https://labs.google/*'],
      },
    ],
    declarative_net_request: {
      rule_resources: [
        { id: 'referer_rules', enabled: true, path: 'rules.json' },
      ],
    },
  },

  modules: ['@wxt-dev/auto-icons'],
  // Icons are pre-generated under public/icon/; auto-icons is disabled.
  autoIcons: { enabled: false },

  vite: () => ({
    plugins: [react()],
    server: {
      host: '127.0.0.1',
    },
  }),
});
