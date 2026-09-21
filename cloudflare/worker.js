// Fake News behind the polyfill.  This is all an operator's worker.js needs.
import {braid_polyfill, BraidResource} from './router.js'
export {BraidResource}
export default braid_polyfill()
