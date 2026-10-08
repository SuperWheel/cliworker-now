export const OWN_ACCOUNT_BUSY: string
export function assertOwnAccountLeaseIdle(root: string): Promise<void>
export function acquireOwnAccountLease(root: string, nonce: string): Promise<void>
export function ownsOwnAccountLease(root: string, nonce: string): Promise<boolean>
export function releaseOwnAccountLease(root: string, nonce: string): Promise<void>
