export function refreshFingerprint(value: unknown): string
export function refreshPrincipal(value: unknown): string | undefined
export function refreshJson(path: string, privateFile?: boolean): Promise<any>
export function writeRefreshJson(path: string, value: unknown): Promise<void>
export function assertPiOmpRefreshSources(root: string, expected?: any): Promise<any>
export function assertPiOmpRefreshCache(root: string, receipt: any): Promise<void>
export function finishPiOmpRefresh(root: string, nonce: string, executable: string, expectedReceipt: any): Promise<void>
