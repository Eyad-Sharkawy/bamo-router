import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_ROUTER_URL = 'https://192.168.100.1';

export type SavedLogin = {
  routerUrl: string;
  user: string;
  pass: string;
  remember: boolean;
};

export type SavedLoginLoadResult = SavedLogin & {
  encryptionAvailable: boolean;
  encryptionUsed: boolean;
};

const PLAIN_PREFIX = 'plain:';

function credentialsFilePath(): string {
  return path.join(app.getPath('userData'), 'saved-login.dat');
}

function defaultSavedLogin(): SavedLoginLoadResult {
  return {
    routerUrl: DEFAULT_ROUTER_URL,
    user: '',
    pass: '',
    remember: true,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    encryptionUsed: false,
  };
}

function parseSavedLoginJson(json: string): SavedLogin {
  const parsed = JSON.parse(json) as Partial<SavedLogin>;
  return {
    routerUrl: parsed.routerUrl?.trim() || DEFAULT_ROUTER_URL,
    user: parsed.user ?? '',
    pass: parsed.pass ?? '',
    remember: parsed.remember !== false,
  };
}

function readFilePayload(): string | null {
  const filePath = credentialsFilePath();
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath);
  if (raw.length === 0) return null;

  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(raw);
    } catch {
      const asText = raw.toString('utf8');
      if (asText.startsWith(PLAIN_PREFIX)) {
        return asText.slice(PLAIN_PREFIX.length);
      }
      return null;
    }
  }

  const asText = raw.toString('utf8');
  if (asText.startsWith(PLAIN_PREFIX)) {
    return asText.slice(PLAIN_PREFIX.length);
  }
  return asText;
}

export function loadSavedLogin(): SavedLoginLoadResult {
  const base = defaultSavedLogin();
  try {
    const json = readFilePayload();
    if (!json) return base;

    const parsed = parseSavedLoginJson(json);
    if (!parsed.remember) {
      return {
        ...base,
        routerUrl: parsed.routerUrl || base.routerUrl,
        remember: false,
        encryptionUsed: safeStorage.isEncryptionAvailable(),
      };
    }

    return {
      ...parsed,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      encryptionUsed: safeStorage.isEncryptionAvailable(),
    };
  } catch {
    return base;
  }
}

export function saveSavedLogin(data: SavedLogin): SavedLoginLoadResult {
  const filePath = credentialsFilePath();

  if (!data.remember) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return {
      routerUrl: data.routerUrl?.trim() || DEFAULT_ROUTER_URL,
      user: '',
      pass: '',
      remember: false,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      encryptionUsed: false,
    };
  }

  const payload = JSON.stringify({
    routerUrl: data.routerUrl?.trim() || DEFAULT_ROUTER_URL,
    user: data.user ?? '',
    pass: data.pass ?? '',
    remember: true,
  });

  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(filePath, safeStorage.encryptString(payload));
  } else {
    fs.writeFileSync(filePath, PLAIN_PREFIX + payload, 'utf8');
  }

  return {
    routerUrl: data.routerUrl?.trim() || DEFAULT_ROUTER_URL,
    user: data.user ?? '',
    pass: data.pass ?? '',
    remember: true,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    encryptionUsed: safeStorage.isEncryptionAvailable(),
  };
}

export function clearSavedLogin(): void {
  const filePath = credentialsFilePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
