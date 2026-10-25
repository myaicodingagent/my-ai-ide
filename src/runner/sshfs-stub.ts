// The runner works on folders of the machine it runs on, so the editor's SSH code is replaced by this (nothing is ever remote).
export const isRemotePath = (_p: unknown): boolean => false
export const parseRemote = (_p: string): null => null
const no = (): never => {
  throw new Error('Not available on the server.')
}
export const exec = no, spawnRemote = no, forwardPort = no, nativePath = no, fromNativePath = no, remoteUnc = no
export const readFile = no, writeFile = no, mkdirp = no, mkdir = no, rename = no, remove = no, statSize = no, requireFile = no
export const readDir = no, isDir = no, listFiles = no, search = no, listWithStats = no, readBytes = no, writeBytes = no
export const connected = (): never[] => []
