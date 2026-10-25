// The runner uses the agent code of the editor without Electron: the few Electron objects that code touches are replaced here.
import { homedir } from 'os'
import { join } from 'path'

export const handlers = new Map<string, (...args: unknown[]) => unknown>()

export const ipcMain = {
  on: (name: string, fn: (...args: unknown[]) => unknown): void => void handlers.set(name, fn),
  handle: (name: string, fn: (...args: unknown[]) => unknown): void => void handlers.set(name, fn),
  removeHandler: (): void => undefined
}

export const app = {
  // Saved conversations and caches go below the runner's own folder on this machine.
  getPath: (_name: string): string => join(process.env.MY_AI_IDE_RUNNER_HOME || join(homedir(), '.my-ai-ide', 'cloud'), 'data'),
  getAppPath: (): string => process.cwd(),
  isPackaged: true
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (s: string): Buffer => Buffer.from(s, 'utf-8'),
  decryptString: (b: Buffer): string => b.toString('utf-8')
}

export class BrowserWindow {}
export const shell = { openExternal: async (): Promise<void> => undefined }
export const clipboard = { writeText: (): void => undefined }
export const dialog = {}
export default { ipcMain, app, safeStorage, BrowserWindow, shell, clipboard, dialog }
