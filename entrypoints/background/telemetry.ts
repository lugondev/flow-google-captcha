/**
 * Human-like telemetry — periodically pings Google's analytics endpoints
 * to keep the session looking organic.
 */

import { state } from './state';

const UA = navigator.userAgent;
let telemetrySessionId = `;${Date.now()}`;

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildBatchLogPayload(): { appEvents: unknown[] } {
  const types = ['FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY'];
  const count = rand(1, 3);
  const events: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const eventType = types[rand(0, types.length - 1)]!;
    events.push({
      event: eventType,
      eventProperties: [
        { key: 'CURRENT_TIME_MS', doubleValue: Date.now() },
        { key: 'DURATION_MS', doubleValue: rand(150, 800) },
        { key: 'USER_AGENT', stringValue: UA },
        { key: 'IS_DESKTOP', booleanValue: true },
      ],
      eventMetadata: { sessionId: telemetrySessionId },
      eventTime: new Date().toISOString(),
    });
  }
  return { appEvents: events };
}

function buildFrontendEventsPayload(): { events: unknown[] } {
  const eventTypes = [
    'FLOW_IMAGE_LATENCY',
    'FLOW_VIDEO_LATENCY',
    'GRID_SCROLL_DEPTH',
    'FLOW_PROJECT_OPEN',
    'FLOW_SCENE_VIEW',
  ];
  const count = rand(1, 4);
  const events: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const et = eventTypes[rand(0, eventTypes.length - 1)]!;
    const params: Record<string, { '@type': string; value: string }> = {
      USER_AGENT: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: UA },
      IS_DESKTOP: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'true' },
    };
    if (et.includes('LATENCY')) {
      params.CURRENT_TIME_MS = {
        '@type': 'type.googleapis.com/google.protobuf.StringValue',
        value: String(Date.now()),
      };
      params.DURATION_MS = {
        '@type': 'type.googleapis.com/google.protobuf.StringValue',
        value: String(rand(100, 600)),
      };
    }
    if (et === 'GRID_SCROLL_DEPTH') {
      params.MEDIA_GENERATION_PAYGATE_TIER = {
        '@type': 'type.googleapis.com/google.protobuf.StringValue',
        value: 'PAYGATE_TIER_TWO',
      };
    }
    events.push({
      eventType: et,
      metadata: {
        sessionId: telemetrySessionId,
        createTime: new Date().toISOString(),
        additionalParams: params,
      },
    });
  }
  return { events };
}

async function sendTelemetry(): Promise<void> {
  if (!state.flowKey || state.appState === 'off') return;

  const headers: Record<string, string> = {
    'Content-Type': 'text/plain;charset=UTF-8',
    authorization: `Bearer ${state.flowKey}`,
  };

  try {
    if (Math.random() < 0.5) {
      await fetch('https://aisandbox-pa.googleapis.com/v1:batchLog', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(buildBatchLogPayload()),
      });
    } else {
      await fetch('https://aisandbox-pa.googleapis.com/v1/flow:batchLogFrontendEvents', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(buildFrontendEventsPayload()),
      });
    }
  } catch {
    // telemetry is best-effort
  }
}

function scheduleTelemetry(): void {
  const delay = rand(45, 120) * 1000;
  setTimeout(() => {
    void sendTelemetry().then(scheduleTelemetry);
  }, delay);
}

export function startTelemetry(): void {
  scheduleTelemetry();
  setInterval(() => {
    telemetrySessionId = `;${Date.now()}`;
  }, rand(25, 35) * 60 * 1000);
}
