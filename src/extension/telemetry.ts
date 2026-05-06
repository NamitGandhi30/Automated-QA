import * as vscode from 'vscode';

interface TelemetryEvent {
  event: string;
  framework?: string;
  provider?: string;
  outcome?: 'pass' | 'fail' | 'skip';
  duration?: number;
  timestamp: string;
}

export class Telemetry {
  private events: TelemetryEvent[] = [];

  isEnabled(): boolean {
    const extensionSetting = vscode.workspace.getConfiguration('automatedqa').get<boolean>('telemetry');
    if (!extensionSetting) { return false; }

    // Respect VS Code's global telemetry setting
    const globalLevel = vscode.workspace.getConfiguration('telemetry').get<string>('telemetryLevel');
    return globalLevel !== 'off';
  }

  log(event: string, data?: Partial<Omit<TelemetryEvent, 'event' | 'timestamp'>>): void {
    if (!this.isEnabled()) { return; }

    const entry: TelemetryEvent = {
      event,
      timestamp: new Date().toISOString(),
      ...data,
    };

    this.events.push(entry);

    // Keep only last 100 events in memory
    if (this.events.length > 100) {
      this.events = this.events.slice(-100);
    }
  }

  getEvents(): TelemetryEvent[] {
    return [...this.events];
  }
}
