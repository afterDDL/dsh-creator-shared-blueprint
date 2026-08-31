/** Host entry for the installable Shared Blueprint bundle. */

/** Runtime policy for Interactive Blueprint authoring and an optional fixture bridge. */
export interface Config {
  /** Additional Creator turns allowed after internal candidate verification misses. */
  capabilityRepairAttempts?: number
  /** JSON document assigned to the Interactive fixture bridge before the Web shell starts. */
  demoBootstrapJson?: string
}

export { default } from './host/index.ts'
export * from './host/index.ts'
