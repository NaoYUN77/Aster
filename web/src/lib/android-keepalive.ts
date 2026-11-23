import { registerPlugin } from "@capacitor/core";
import { isCapacitor } from "./platform";

export type AndroidKeepAliveStatus = {
  running: boolean;
  ignoringBatteryOptimizations: boolean;
};

type AsterKeepAlivePlugin = {
  start(options: {
    baseUrl: string;
    token: string;
    muted: boolean;
    notifyEnabled: boolean;
  }): Promise<{ started: boolean }>;
  updateConfig(options: {
    muted?: boolean;
    notifyEnabled?: boolean;
  }): Promise<{ running: boolean }>;
  stop(): Promise<{ stopped: boolean }>;
  getStatus(): Promise<AndroidKeepAliveStatus>;
  requestBatteryOptimizationExemption(): Promise<{
    opened?: boolean;
    ignoringBatteryOptimizations?: boolean;
  }>;
};

const AsterKeepAlive = registerPlugin<AsterKeepAlivePlugin>("AsterKeepAlive");

export async function startAndroidKeepAlive(options: {
  baseUrl: string;
  token: string;
  muted: boolean;
  notifyEnabled: boolean;
}): Promise<boolean> {
  if (!isCapacitor()) return false;
  try {
    const res = await AsterKeepAlive.start(options);
    return res.started === true;
  } catch {
    return false;
  }
}

export async function updateAndroidKeepAlive(options: {
  muted?: boolean;
  notifyEnabled?: boolean;
}): Promise<boolean> {
  if (!isCapacitor()) return false;
  try {
    const res = await AsterKeepAlive.updateConfig(options);
    return res.running === true;
  } catch {
    return false;
  }
}

export async function stopAndroidKeepAlive(): Promise<void> {
  if (!isCapacitor()) return;
  try {
    await AsterKeepAlive.stop();
  } catch {
    /* ignore */
  }
}

export async function getAndroidKeepAliveStatus(): Promise<AndroidKeepAliveStatus | null> {
  if (!isCapacitor()) return null;
  try {
    return await AsterKeepAlive.getStatus();
  } catch {
    return null;
  }
}

export async function requestAndroidBatteryExemption(): Promise<boolean> {
  if (!isCapacitor()) return false;
  try {
    const res = await AsterKeepAlive.requestBatteryOptimizationExemption();
    return Boolean(res.opened || res.ignoringBatteryOptimizations);
  } catch {
    return false;
  }
}
