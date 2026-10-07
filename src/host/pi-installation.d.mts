export interface PiInstallation {
  root: string
  dist: string
  version: '1.0.2' | '1.0.4'
  executable: string
}
export function inspectPiInstallation(entry: string): PiInstallation
