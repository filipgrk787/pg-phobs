export interface AriUpdate {
  roomCode: string;
  rateCode: string;
  nights: {
    date: string;
    price: number;
    free: number;
    stopSell: boolean;
  }[];
}

export interface ChannelAdapter {
  pushAri(propertyId: string, update: AriUpdate[]): Promise<void>;
}

export class NoopAdapter implements ChannelAdapter {
  async pushAri(_propertyId: string, _update: AriUpdate[]): Promise<void> {}
}

export class MockOtaAdapter implements ChannelAdapter {
  constructor(private readonly baseUrl: string) {}

  async pushAri(propertyId: string, update: AriUpdate[]): Promise<void> {
    const url = `${this.baseUrl}/ari`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ propertyId, updates: update }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MockOTA ARI push failed ${res.status}: ${text}`);
    }
  }
}

export function getAdapter(adapterName: string): ChannelAdapter {
  const baseUrl = process.env['MOCK_OTA_API_URL'] ?? process.env['API_BASE_URL'] ?? 'http://localhost:4000';
  switch (adapterName) {
    case 'mock-ota': return new MockOtaAdapter(
      (process.env['MOCK_OTA_API_URL'] ?? 'http://mock-ota:4000'),
    );
    default: return new NoopAdapter();
  }
}
