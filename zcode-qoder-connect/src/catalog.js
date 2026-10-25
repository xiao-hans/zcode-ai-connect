/**
 * Qoder model catalog: the roster the endpoint publishes.
 *
 * Content lives in the upstream module (FALLBACK_MODELS plus the live roster
 * from the Qoder model list); this holder adds the two things the endpoint
 * needs on top of it — visibility and provenance. Visibility is separate from
 * content because a signed-out account must expose *no* models: serving the
 * fallback roster to a signed-out user offers models that can only fail, which
 * is worse than showing nothing.
 *
 * @module zcode-qoder-connect/catalog
 */

import { FALLBACK_MODELS } from './upstream.js'

/** The roster the endpoint serves before its first successful fetch. */
function initialRoster() {
  return [...FALLBACK_MODELS]
}

export class QoderCatalog {
  constructor() {
    this.models = initialRoster()
    this.visible = false
    /** Provenance of the roster currently held. */
    this.source = 'fallback'
    this.fetchedAtMs = undefined
  }

  /** Current entries; empty while the catalog has no usable credential. */
  current() {
    if (!this.visible) return []
    return this.models
  }

  /** Replace the list with a freshly fetched roster. */
  set(models, { source, fetchedAtMs } = {}) {
    this.models = [...models]
    if (source !== undefined) this.source = source
    this.fetchedAtMs = fetchedAtMs ?? Date.now()
  }

  isVisible() {
    return this.visible
  }

  /** Show or hide the whole catalog. Returns whether the value changed. */
  setVisible(visible) {
    if (this.visible === visible) return false
    this.visible = visible
    return true
  }

  /** Models to fall back to when the upstream fetch fails; ignores visibility. */
  fallback() {
    return this.models
  }
}
